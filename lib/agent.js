// oh-my-dsh — the agent plane.
//
// Mounted either process-wide on surfaces that compose their agent in the
// root realm (TUI / headless, where the host half activates it), or as a row
// inside the shipped `oh-my-dsh` agent preset (Web sessions).
//
// Provides tiered model routing (think = strong, build = cheap), automatic
// vision-tier routing for image messages, failure auto-escalation, the
// high-impact guard, on-demand advisor/review consultations, subagent
// tiering, image generation via a configured image-capable model, the
// /omd command, and the routing prompt section.

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { generateCodexImage } from './codex-image.js'
import { EFFORTS, SUBAGENT_POLICIES, loadConfig, viewFromState, visionDescriptionStore, visionImageHash } from './config.js'
import { attemptsFor, resolveImageRoute } from './image-route.js'
import { collectImageCandidates, collectSvgCandidates, isHighImpact, resolveTierSpec } from './pure.js'

export const name = 'oh-my-dsh-agent'

const ADVISOR_SYSTEM = [
  'You are the Oh My DSH advisor: the strong-tier (think) consultant for a coding agent that implements work in a cheaper model.',
  'Answer ONE explicit decision question using the provided evidence. Do not implement; do not take over the task.',
  'Return, in order: Recommendation; Decisive evidence; Rejected alternatives; Risks; Implementation constraints; Acceptance criteria; Remaining uncertainty.',
  'If the evidence is insufficient, state the cheapest additional check needed instead of guessing. Be concise.',
].join('\n')

const REVIEW_SYSTEM = [
  'You are the Oh My DSH reviewer: an independent strong-tier (think) reviewer for a coding agent.',
  'Review the provided work state and evidence for correctness, security, data integrity, compatibility, and completeness.',
  'Return, in order: Verdict (APPROVE or NEEDS-CHANGES or BLOCKED); Issues ranked by severity with concrete fixes; Unverified claims; Recommended follow-ups.',
  'Only claim what the evidence supports. Be concise.',
].join('\n')

// ---- vision-native history scrub -------------------------------------------
// Image turns run natively on the vision model, so the image stays in the
// session history (the chat keeps showing it). Text-only models would fail on
// that history, so requests to them get their image parts replaced here — at
// the llm.stream boundary, before any adapter converts the content — with the
// background vision description when one is cached (keyed by image sha256),
// or dropped when it is not yet ready.

const OMD_STREAM_SCRUB = Symbol.for('oh-my-dsh.stream.scrubbed')
const imageModalityCache = new Map()

async function modelAcceptsImages(llm, provider, model) {
  const key = provider + '\u0000' + model
  const hit = imageModalityCache.get(key)
  if (hit && Date.now() - hit.at < 60000) return hit.value
  let accepts = false
  if (llm && typeof llm.resolveModelInfo === 'function') {
    try {
      const info = await llm.resolveModelInfo(provider, model)
      accepts = !!(info && Array.isArray(info.inputModalities) && info.inputModalities.indexOf('image') !== -1)
    } catch (e) { accepts = false }
  }
  if (!accepts) {
    try {
      const list = await llm.listModels(provider)
      const found = (list || []).find((m) => String(m.id || '') === String(model))
      accepts = !!(found && Array.isArray(found.inputModalities) && found.inputModalities.indexOf('image') !== -1)
    } catch (e) { accepts = false }
  }
  imageModalityCache.set(key, { at: Date.now(), value: accepts })
  return accepts
}

/** Replace image parts with the cached vision description (async lookup). */
async function scrubImagesFromContent(blocks, attachments) {
  if (!Array.isArray(blocks)) return blocks
  const out = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') { out.push(block); continue }
    if (block.type === 'image') {
      try {
        if (attachments && typeof attachments.readImage === 'function' && block.attachment) {
          const stored = await attachments.readImage(block.attachment)
          const hash = visionImageHash(Buffer.from(stored.data))
          const entry = visionDescriptionStore.get(hash)
          if (entry !== undefined) {
            // The entry is a promise queued at admission; wait for the
            // description so the working model's first request already has it
            // (capped — a slow describe degrades to dropping the part).
            let description = null
            if (typeof entry === 'string') description = entry
            else {
              description = await Promise.race([
                Promise.resolve(entry),
                new Promise((resolve) => setTimeout(() => resolve(null), 20000)),
              ])
            }
            if (description) {
              out.push({ type: 'text', text: '<image description>\n' + description })
              continue
            }
          }
        }
      } catch (e) { /* fall through to drop */ }
      continue
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) {
      out.push({ ...block, content: await scrubImagesFromContent(block.content, attachments) })
      continue
    }
    out.push(block)
  }
  return out
}

/**
 * Wrap llm.streamWithRegistration once — the single funnel both the agent
 * loop (preparedCall.stream) and plain llm.stream calls go through — and
 * replace image parts with the vision description for models that cannot see
 * them. Messages travel inside the request; the prepared-call config check
 * compares only provider/model/effort/temperature/tokens, so scrubbed
 * messages pass it unchanged.
 */
function wrapStreamScrub(ctx, llm) {
  if (!llm || typeof llm.streamWithRegistration !== 'function' || llm.streamWithRegistration[OMD_STREAM_SCRUB]) return
  const original = llm.streamWithRegistration.bind(llm)
  const scrubbed = async function* (options, prepared) {
    let opts = options
    try {
      const provider = options && options.provider
      const model = options && options.model
      if (provider && model && Array.isArray(options.messages)) {
        const sees = await modelAcceptsImages(llm, provider, model)
        if (!sees) {
          const attachments = ctx.get('attachments')
          const messages = []
          for (const m of options.messages) {
            messages.push(m && Array.isArray(m.content) ? { ...m, content: await scrubImagesFromContent(m.content, attachments) } : m)
          }
          opts = { ...options, messages }
        }
      }
    } catch (e) { /* pass through untouched */ }
    yield* original(opts, prepared)
  }
  scrubbed[OMD_STREAM_SCRUB] = true
  llm.streamWithRegistration = scrubbed
}

/**
 * Activate every agent-plane contribution on one context.
 * @param ctx - the fiber context (root realm in TUI, preset realm in Web).
 * @param cfg - the shared config from lib/config.js loadConfig().
 */
export function activateAgentPlane(ctx, cfg) {
  const llm = ctx.get('llm')
  wrapStreamScrub(ctx, llm)
  const tools = ctx.get('tools')
  const planMode = ctx.get('planMode')
  const agentDefaultModel = ctx.get('agentDefaultModel')
  const systemPrompt = ctx.get('systemPrompt')
  const subagents = ctx.get('subagents')
  const agents = ctx.get('agents')
  const jobs = ctx.get('jobs')

  if (jobs && typeof jobs.attachController === 'function') {
    try { jobs.attachController('oh-my-dsh-worker') } catch (e) {
      console.error('oh-my-dsh: jobs controller attach failed (background omd_worker may be refused): ' + String(e && e.message || e))
    }
  }

  const childTiers = new WeakMap()
  const sessionModes = new WeakMap()
  const escalations = new WeakMap()
  const diag = {
    requestSteps: 0, guardChecks: 0, guardDenies: 0, headerWrites: 0, inboxSeen: 0,
    planFlips: 0, errorsSeen: 0, escalations: 0, imagesGenerated: 0,
    lastRouting: '', lastGuard: '', lastGuardError: '', lastHeader: '', lastError: '', lastEscalation: '',
  }

  let providerCache = null
  let providerCacheAt = 0
  function availableProviders() {
    if (!llm || typeof llm.listProviders !== 'function') return []
    const now = Date.now()
    if (providerCache && now - providerCacheAt < 10000) return providerCache
    try {
      providerCache = (llm.listProviders() || []).map((p) => p.id)
      providerCacheAt = now
    } catch (e) {
      console.error('oh-my-dsh: listProviders failed: ' + String(e && e.message || e))
      providerCache = providerCache || []
    }
    return providerCache
  }

  function registered(p) { return availableProviders().indexOf(p) !== -1 }
  function tierLabel(tier) {
    if (!tier || !tier.provider) return '(unset)'
    return tier.provider + '/' + tier.model + (tier.effort ? ' (' + tier.effort + ')' : '')
  }
  function visionTarget() {
    const v = cfg.state.vision
    if (v && v.provider && v.model) return { provider: v.provider, model: v.model, effort: undefined }
    return null
  }
  function agentIdentity(agent) {
    let id = '?'
    let origin = '?'
    try { id = String(agent && agent.id) } catch (e) { id = 'unreadable' }
    try { origin = String(agent && agent.session && agent.session.header && agent.session.header.origin || '') || '(main)' } catch (e) { origin = 'unreadable' }
    return id + '[' + origin + ']'
  }
  function isChildAgent(agent) {
    if (!agent) return false
    if (childTiers.has(agent)) return true
    try { return !!(agent.session && agent.session.header && agent.session.header.origin === 'subagent') } catch (e) { return false }
  }
  function effectiveMode(agent) {
    if (agent && sessionModes.has(agent)) return sessionModes.get(agent)
    return cfg.state.mode
  }
  function planActive(agent) {
    let active = false
    try {
      if (planMode && agent) {
        const st = planMode.get(agent)
        if (st && st.active) active = true
      }
    } catch (e) {}
    return active
  }
  function escalationActive(agent) {
    if (!agent || !escalations.has(agent)) return false
    const e = escalations.get(agent)
    if (e.until > Date.now()) return true
    escalations.delete(agent)
    return false
  }
  function resolveTarget(agent, planActiveOverride) {
    const spec = {
      explicitTier: agent && childTiers.has(agent) ? childTiers.get(agent) : undefined,
      sessionMode: agent ? sessionModes.get(agent) : undefined,
      escalated: escalationActive(agent),
      isChild: isChildAgent(agent),
      subagentPolicy: cfg.state.subagentPolicy,
      mode: cfg.state.mode,
      planActive: planActiveOverride === undefined ? planActive(agent) : planActiveOverride,
    }
    const tierName = resolveTierSpec(spec)
    if (tierName === 'strong') return cfg.state.strong
    if (tierName === 'cheap') return cfg.state.cheap
    if (tierName === 'vision') return visionTarget()
    return null
  }
  function headerConfigOf(session) {
    try {
      const h = session && session.requestHeader ? session.requestHeader() : undefined
      return h ? h.config : undefined
    } catch (e) { return undefined }
  }
  function ensureHeader(agent, target) {
    if (!agent || !target || !target.provider || !target.model) return
    try {
      const session = agent.session
      if (!session || typeof session.append !== 'function' || typeof session.requestHeader !== 'function') return
      const cur = headerConfigOf(session)
      if (cur && cur.provider === target.provider && cur.model === target.model && (cur.reasoningEffort || undefined) === (target.effort || undefined)) return
      session.append('request/header', {
        header: { config: { provider: target.provider, model: target.model, ...(target.effort ? { reasoningEffort: target.effort } : {}) } },
        reason: 'change',
      })
      diag.headerWrites = diag.headerWrites + 1
      diag.lastHeader = 'wrote ' + tierLabel(target) + ' for ' + agentIdentity(agent) + ' (was ' + (cur ? cur.provider + '/' + cur.model : 'none') + ')'
    } catch (e) {
      diag.lastHeader = 'header write failed: ' + String(e && e.message || e)
      console.error('oh-my-dsh: header write failed: ' + String(e && e.message || e))
    }
  }
  function routeMain(agent, planActiveOverride) {
    if (!agent || isChildAgent(agent)) return
    if (effectiveMode(agent) === 'off') return
    const target = resolveTarget(agent, planActiveOverride)
    if (target) ensureHeader(agent, target)
  }
  function defaultSelectionTarget() {
    try {
      if (agentDefaultModel) {
        const sel = agentDefaultModel.currentSelection()
        if (sel && typeof sel.provider === 'string') {
          return { provider: sel.provider, model: sel.model, effort: sel.reasoningEffort || 'high' }
        }
      }
    } catch (e) {}
    return null
  }
  function effectiveExecutionTier(agent) {
    if (effectiveMode(agent) === 'off') {
      try {
        const sel = agentDefaultModel && agentDefaultModel.currentSelection()
        if (sel && sel.provider === cfg.state.cheap.provider && sel.model === cfg.state.cheap.model) return 'cheap'
      } catch (e) {}
      return 'strong'
    }
    const target = resolveTarget(agent)
    return target === cfg.state.cheap ? 'cheap' : 'strong'
  }
  async function listModelsText() {
    if (!llm) return '(llm service unavailable)'
    const lines = []
    for (const provider of availableProviders()) {
      try {
        const models = await llm.listModels(provider)
        lines.push(provider + ': ' + ((models || []).map((m) => m.id).join(', ') || '(no catalog)'))
      } catch (e) {
        lines.push(provider + ': (listModels failed: ' + String(e && e.message || e) + ')')
      }
    }
    return lines.join('\n')
  }
  function statusText(agent) {
    let sessionDefault = ''
    if (agentDefaultModel) {
      try {
        const sel = agentDefaultModel.currentSelection()
        if (sel && typeof sel.provider === 'string') sessionDefault = 'session default: ' + sel.provider + '/' + sel.model + ' (' + (sel.reasoningEffort || 'default') + ')'
      } catch (e) {}
    }
    const c = cfg.state
    return [
      'Oh My DSH — tiered model routing',
      '  mode: global=' + c.mode + ', this session=' + (agent ? (sessionModes.has(agent) ? sessionModes.get(agent) : c.mode) : 'n/a') + ' (per-session via /omd strong|cheap|auto|off; escalate: ' + c.escalateThreshold + ' errors / ' + Math.round(c.escalateWindowMs / 1000) + 's window -> ' + Math.round(c.escalateTtlMs / 1000) + 's strong)',
      '  think:  ' + tierLabel(c.strong),
      '  build:  ' + tierLabel(c.cheap),
      '  vision: ' + tierLabel(c.vision) + ' (auto: ' + (c.visionAuto ? 'on' : 'off') + ' — describes images in the background; the working tier answers from the description, the session model never switches)',
      '  image:  ' + c.image.model + (c.image.provider ? ' via ' + c.image.provider : ' @ ' + (c.image.baseUrl || 'custom endpoint')) + ' (key: ' + (c.image.apiKey ? 'inline' : c.image.apiKeyEnv || 'provider-declared') + ', out ./' + c.image.outDir + ')',
      '  subagents: ' + c.subagentPolicy + '; guard: ' + (c.guardEnabled ? 'on' : 'off'),
      '  diag: requestSteps=' + diag.requestSteps + ' guardChecks=' + diag.guardChecks + ' guardDenies=' + diag.guardDenies + ' headerWrites=' + diag.headerWrites + ' inboxSeen=' + diag.inboxSeen + ' planFlips=' + diag.planFlips + ' errorsSeen=' + diag.errorsSeen + ' escalations=' + diag.escalations + ' imagesGenerated=' + diag.imagesGenerated,
      diag.lastRouting ? '  lastRouting: ' + diag.lastRouting : '',
      diag.lastGuard ? '  lastGuard: ' + diag.lastGuard : '',
      diag.lastGuardError ? '  lastGuardError: ' + diag.lastGuardError : '',
      diag.lastHeader ? '  lastHeader: ' + diag.lastHeader : '',
      diag.lastError ? '  lastError: ' + diag.lastError : '',
      diag.lastEscalation ? '  lastEscalation: ' + diag.lastEscalation : '',
      sessionDefault ? '  ' + sessionDefault : '  session default: unavailable',
      '  providers: ' + availableProviders().join(', '),
    ].join('\n')
  }
  async function persistConfig() {
    return await cfg.update(viewFromState(cfg.state))
  }
  async function applyRoute(tier, persist, agent) {
    if (tier === 'auto') {
      if (agent) sessionModes.delete(agent)
      if (agent && !isChildAgent(agent)) routeMain(agent)
      return { applied: tier, message: 'Routing mode set to auto for THIS session (plan mode -> think tier, execution -> build tier). Other sessions keep their own mode.' }
    }
    if (tier === 'off') {
      if (agent) sessionModes.set(agent, 'off')
      if (agent && !isChildAgent(agent)) {
        const def = defaultSelectionTarget()
        if (def) ensureHeader(agent, def)
      }
      return { applied: tier, message: 'Routing disabled for THIS session; its model returned to the default. Other sessions are unaffected.' }
    }
    const target = tier === 'strong' ? cfg.state.strong : (tier === 'cheap' ? cfg.state.cheap : null)
    if (!target) return { applied: tier, message: 'Unknown tier "' + tier + '". Use strong, cheap, auto, or off.' }
    if (target.provider && !registered(target.provider)) {
      return { applied: tier, message: 'Provider "' + target.provider + '" is not registered. Registered: ' + availableProviders().join(', ') }
    }
    if (agent) sessionModes.set(agent, tier)
    if (agent && !isChildAgent(agent)) ensureHeader(agent, target)
    let persisted = ''
    if (persist && agentDefaultModel) {
      try {
        await agentDefaultModel.saveSelection({ provider: target.provider, model: target.model, reasoningEffort: target.effort || 'high' })
        persisted = ' Saved as the session default.'
      } catch (e) {
        persisted = ' Could not persist the session default: ' + String(e && e.message || e)
      }
    }
    return { applied: tier, message: 'This session now routes to the ' + tier + ' tier (' + tierLabel(target) + '). Other sessions keep their own mode.' + persisted }
  }
  async function applyConfigure(args, agent) {
    if (args.tier === 'vision') {
      if (!args.provider || !args.model) return { ok: false, message: 'usage: configure tier "vision" with provider and model' }
      if (!registered(args.provider)) return { ok: false, message: 'Provider "' + args.provider + '" is not registered. Registered: ' + availableProviders().join(', ') }
      cfg.state.vision = { provider: args.provider, model: args.model }
      const saved = await persistConfig()
      return { ok: true, message: 'Vision tier: ' + tierLabel(cfg.state.vision) + '.' + (saved ? ' Saved to oh-my-dsh settings.' : ' (persist failed)') }
    }
    const tierName = args.tier === 'strong' ? 'strong' : 'cheap'
    if (!args.provider || !args.model) return { ok: false, message: 'usage: configure tier "strong"|"cheap" with provider and model' }
    if (!registered(args.provider)) {
      return { ok: false, message: 'Provider "' + args.provider + '" is not registered. Registered: ' + availableProviders().join(', ') }
    }
    const effort = args.reasoningEffort || cfg.state[tierName].effort || (tierName === 'strong' ? 'max' : 'high')
    cfg.state[tierName] = { provider: args.provider, model: args.model, effort }
    if (args.subagentPolicy && SUBAGENT_POLICIES.indexOf(args.subagentPolicy) !== -1) cfg.state.subagentPolicy = args.subagentPolicy
    if (agent && !isChildAgent(agent) && (effectiveMode(agent) === tierName || effectiveMode(agent) === 'auto')) ensureHeader(agent, cfg.state[tierName])
    let persisted = ''
    if (args.sessionOnly !== true) persisted = (await persistConfig()) ? ' Saved to oh-my-dsh settings.' : ' (persist failed)'
    return { ok: true, message: 'Configured ' + tierName + ' tier: ' + tierLabel(cfg.state[tierName]) + '. Subagent policy: ' + cfg.state.subagentPolicy + '.' + persisted }
  }

  // ---- image generation ----------------------------------------------------

  const IMAGE_EXT = { '\u0089PNG': 'png', '\u00ff\u00d8\u00ff': 'jpg', 'RIFF': 'webp', 'GIF8': 'gif' }
  function imageExtensionOf(bytes) {
    const head = String.fromCharCode.apply(null, Array.from(bytes.slice(0, 8)))
    if (head.startsWith('\u0089PNG')) return 'png'
    if (head.startsWith('\u00ff\u00d8\u00ff')) return 'jpg'
    if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp'
    if (head.startsWith('GIF8')) return 'gif'
    return 'png'
  }
  function saveImageBytes(bytes, outDir, seq) {
    const dir = resolve(process.cwd(), outDir || 'oh-my-dsh-images')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(dir, 'omd-' + stamp + '-' + seq + '.' + imageExtensionOf(bytes))
    writeFileSync(file, bytes)
    return file
  }
  function saveSvgText(text, outDir, seq) {
    const dir = resolve(process.cwd(), outDir || 'oh-my-dsh-images')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(dir, 'omd-' + stamp + '-' + seq + '.svg')
    writeFileSync(file, text, 'utf8')
    return file
  }
  async function decodeCandidate(cand, signal) {
    if (cand.kind === 'b64') {
      const buf = Buffer.from(cand.data.replace(/\s+/g, ''), 'base64')
      if (buf.length > 64) return buf
      return null
    }
    if (cand.kind === 'data') {
      const m = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(cand.data)
      if (!m) return null
      const buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64')
      return buf.length > 64 ? buf : null
    }
    if (cand.kind === 'url') {
      const res = await fetch(cand.url, { signal })
      if (!res.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      return buf.length > 64 ? buf : null
    }
    return null
  }
  async function httpJson(url, init, signal) {
    let res
    try {
      res = await fetch(url, { ...init, signal })
    } catch (e) {
      throw new Error('request failed: ' + String(e && e.message || e))
    }
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch (e) {}
    if (!res.ok) {
      const detail = data && data.error ? JSON.stringify(data.error).slice(0, 220) : text.slice(0, 220)
      throw new Error('HTTP ' + res.status + ' ' + detail)
    }
    return data
  }
  /** Combine an abort signal with a hard timeout so a fetch can never hang. */
  function boundedSignal(signal, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs)
    if (!signal) return timeout
    try { return AbortSignal.any([signal, timeout]) } catch (e) { return timeout }
  }
  async function httpJsonBounded(url, init, signal, timeoutMs) {
    const combined = boundedSignal(signal, timeoutMs)
    try {
      return await httpJson(url, init, combined)
    } catch (e) {
      if (combined.aborted && !(signal && signal.aborted)) {
        throw new Error('timed out after ' + Math.round(timeoutMs / 1000) + 's')
      }
      throw e
    }
  }
  /**
   * Generate images through the configured image model. With a provider
   * selected (e.g. opencode-go) the route is resolved from the provider's own
   * configuration — base URL from the pi-ai catalog, API key from the
   * credentials service — and the model is called like an ordinary chat model
   * that can emit images (gpt-5.6-luna style): chat completions with image
   * output modalities, the Responses API, and finally the classic
   * images/generations endpoint. A custom base URL + key is used when no
   * provider is selected.
   */
  async function generateImages(prompt, opts, signal) {
    const c = cfg.state.image
    const route = await resolveImageRoute(ctx, c)
    // Chat models that generate images need to be told how to hand the
    // picture back: an actual image where the API supports it, else SVG.
    const instruction = 'Generate the requested picture now. Return the picture itself as an actual image (your native image generation) — do not describe it and do not return SVG markup unless you have no image output capability.'
    const userPrompt = String(prompt || '').trim()

    // Codex route: the official Codex client generates images through the
    // ChatGPT images endpoint (model gpt-image-2 via the imagegen tool), not
    // through the chat model's native output — speak that endpoint directly.
    if (route.api === 'openai-codex-responses' || route.provider === 'openai-codex') {
      const result = await generateCodexImage(userPrompt, signal)
      if (!result.ok || !result.b64 || result.b64.length === 0) {
        return { ok: false, paths: [], count: 0, message: result.message || 'Codex image generation failed.' }
      }
      const paths = []
      let seq = 0
      for (const b64 of result.b64) {
        try {
          const bytes = Buffer.from(b64.replace(/\s+/g, ''), 'base64')
          if (bytes.length > 64) {
            seq = seq + 1
            paths.push(saveImageBytes(bytes, route.outDir, seq))
          }
        } catch (e) { console.error('oh-my-dsh: codex image decode failed: ' + String(e && e.message || e)) }
      }
      if (paths.length === 0) {
        return { ok: false, paths: [], count: 0, message: 'Codex returned image data but none could be decoded.' }
      }
      diag.imagesGenerated = diag.imagesGenerated + paths.length
      return { ok: true, paths, count: paths.length, message: 'Generated ' + paths.length + ' image(s) with gpt-image-2 (Codex).\n' + paths.map((p) => '  ' + p).join('\n') }
    }

    if (!route.apiKey) {
      return { ok: false, paths: [], count: 0, message: 'No API key for image generation. ' + (route.provider ? 'The provider "' + route.provider + '" declares ' + (route.keyEnv ? 'the key env var ' + route.keyEnv : 'no key env var') + ', which is not configured' : 'Set an env var or paste a key in the oh my dsh settings tab') + '.' }
    }
    if (!route.baseUrl) return { ok: false, paths: [], count: 0, message: 'No base URL resolvable for the image model. Pick a registered provider in the oh my dsh settings tab, or set a custom base URL.' }
    const auth = { Authorization: 'Bearer ' + route.apiKey }
    const candidates = []
    const responses = []
    const attemptErrors = []
    for (const kind of attemptsFor(route.api)) {
      if (candidates.length > 0) break
      try {
        let url = route.baseUrl + '/chat/completions'
        let body = { model: route.model, messages: [{ role: 'user', content: userPrompt + '\n\n' + instruction }], ...(route.useModalities ? { modalities: ['image', 'text'] } : {}) }
        if (kind === 'responses') {
          url = route.baseUrl + '/responses'
          body = { model: route.model, input: userPrompt + '\n\n' + instruction, ...(route.useModalities ? { modalities: ['image', 'text'] } : {}) }
        } else if (kind === 'images') {
          url = route.baseUrl + '/images/generations'
          body = { model: route.model, prompt: userPrompt, n: 1 }
        }
        const data = await httpJsonBounded(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
          body: JSON.stringify(body),
        }, signal, 120000)
        responses.push(data)
        collectImageCandidates(data, candidates)
      } catch (e) {
        attemptErrors.push(kind + ': ' + String(e && e.message || e))
      }
    }
    if (candidates.length === 0) {
      // The model may answer with SVG markup instead of an image part (e.g.
      // gpt-5.6-luna through gateways that do not attach image parts) —
      // treat SVG blocks as generated images.
      const svgs = []
      for (const data of responses) collectSvgCandidates(data, svgs)
      if (svgs.length > 0) {
        const paths = []
        let seq = 0
        for (const cand of svgs.slice(0, 8)) {
          seq = seq + 1
          paths.push(saveSvgText(cand.data, route.outDir, seq))
        }
        diag.imagesGenerated = diag.imagesGenerated + paths.length
        return { ok: true, paths, count: paths.length, message: 'Generated ' + paths.length + ' image(s) as SVG with ' + route.model + (route.provider ? ' (' + route.provider + ')' : '') + '.\n' + paths.map((p) => '  ' + p).join('\n') }
      }
      const detail = attemptErrors.length > 0 ? ' Attempts: ' + attemptErrors.join(' | ') : ''
      return { ok: false, paths: [], count: 0, message: 'No image came back from ' + route.model + ' via ' + (route.provider || route.baseUrl) + '.' + detail }
    }
    const paths = []
    let seq = 0
    for (const cand of candidates) {
      try {
        const bytes = await decodeCandidate(cand, signal)
        if (bytes) {
          seq = seq + 1
          paths.push(saveImageBytes(bytes, route.outDir, seq))
        }
      } catch (e) { console.error('oh-my-dsh: image candidate failed: ' + String(e && e.message || e)) }
    }
    if (paths.length === 0) {
      return { ok: false, paths: [], count: 0, message: 'The model answered but no decodable image was found in its response.' }
    }
    diag.imagesGenerated = diag.imagesGenerated + paths.length
    return { ok: true, paths, count: paths.length, message: 'Generated ' + paths.length + ' image(s) with ' + route.model + (route.provider ? ' (' + route.provider + ')' : '') + '.\n' + paths.map((p) => '  ' + p).join('\n') }
  }

  // ---- routing listeners ----------------------------------------------------

  if (typeof ctx.on === 'function') {
    ctx.on('agent/request', async (payload, next) => {
      const config = await next()
      diag.requestSteps = diag.requestSteps + 1
      const stepNo = diag.requestSteps
      try {
        const agent = payload && payload.agent
        if (effectiveMode(agent) === 'off') { diag.lastRouting = 'step' + stepNo + ': mode=off, untouched (' + agentIdentity(agent) + ')'; return config }
        if (!config || typeof config !== 'object' || typeof config.provider !== 'string') { diag.lastRouting = 'step' + stepNo + ': no valid config'; return config }
        if (!isChildAgent(agent)) {
          diag.lastRouting = 'step' + stepNo + ': main agent ' + agentIdentity(agent) + ' — routing via session header (inbox/plan listeners)'
          return config
        }
        const target = resolveTarget(agent)
        if (!target || !target.provider || availableProviders().indexOf(target.provider) === -1) { diag.lastRouting = 'step' + stepNo + ': target unavailable (' + agentIdentity(agent) + ')'; return config }
        if (config.provider === target.provider && config.model === target.model && (config.reasoningEffort || undefined) === (target.effort || undefined)) { diag.lastRouting = 'step' + stepNo + ': child already ' + tierLabel(target) + ' (' + agentIdentity(agent) + ')'; return config }
        const nextConfig = { ...config, provider: target.provider, model: target.model, ...(target.effort ? { reasoningEffort: target.effort } : {}) }
        diag.lastRouting = 'step' + stepNo + ': child swapped ' + config.provider + '/' + config.model + ' -> ' + tierLabel(target) + ' (' + agentIdentity(agent) + ')'
        return nextConfig
      } catch (e) {
        diag.lastRouting = 'step' + stepNo + ': ERROR ' + String(e && e.message || e)
        console.error('oh-my-dsh: agent/request routing failed: ' + String(e && e.message || e))
        return config
      }
    })

    ctx.on('agent/inbox/inserted', (payload) => {
      diag.inboxSeen = diag.inboxSeen + 1
      try {
        const agent = payload && payload.agent
        const message = payload && payload.message
        if (!agent || !message) return
        if (effectiveMode(agent) === 'off') return
        try { if (!message.source || message.source.kind !== 'user') return } catch (e) {}
        if (isChildAgent(agent)) return
        // The working tier runs EVERY turn: the admission wrapper routes the
        // header to the vision model only so the image gate admits the
        // message (the image stays in the chat); the vision model describes it
        // in the background and the llm.stream scrub hands the description to
        // text-only models. Route back to the tier before the turn starts.
        routeMain(agent)
        diag.lastRouting = 'inbox: routed ' + agentIdentity(agent)
      } catch (e) {
        console.error('oh-my-dsh: inbox routing failed: ' + String(e && e.message || e))
      }
    })

    ctx.on('session/event', (session, event) => {
      try {
        if (!event || event.type !== 'plan/mode') return
        diag.planFlips = diag.planFlips + 1
        const active = !!(event.data && event.data.active)
        const agent = agents ? agents.get(session.id) : undefined
        if (!agent || isChildAgent(agent)) return
        if (effectiveMode(agent) === 'off') return
        routeMain(agent, active)
      } catch (e) {
        console.error('oh-my-dsh: plan-flip routing failed: ' + String(e && e.message || e))
      }
    })

    ctx.on('agent/error', (payload) => {
      diag.errorsSeen = diag.errorsSeen + 1
      try {
        const agent = payload && payload.agent
        if (!agent) return
        diag.lastError = '#' + diag.errorsSeen + ' ' + agentIdentity(agent) + ': ' + String((payload && payload.error && (payload.error.message || payload.error)) || 'unknown').slice(0, 140)
        if (effectiveMode(agent) === 'off') return
        const now = Date.now()
        let rec = escalations.get(agent)
        if (!rec || now - rec.windowStart > cfg.state.escalateWindowMs) {
          rec = { count: 0, windowStart: now, until: 0 }
          escalations.set(agent, rec)
        }
        rec.count = rec.count + 1
        if (rec.count >= cfg.state.escalateThreshold && rec.until < now) {
          rec.until = now + cfg.state.escalateTtlMs
          diag.escalations = diag.escalations + 1
          diag.lastEscalation = '#' + diag.escalations + ' escalated ' + agentIdentity(agent) + ' for ' + Math.round(cfg.state.escalateTtlMs / 1000) + 's after ' + rec.count + ' errors'
          if (!isChildAgent(agent)) ensureHeader(agent, cfg.state.strong)
          else { try { childTiers.set(agent, 'strong') } catch (e) {} }
        }
      } catch (e) {
        console.error('oh-my-dsh: error handler failed: ' + String(e && e.message || e))
      }
    })

    ctx.on('tools/pre-execute', async (exec, next) => {
      diag.guardChecks = diag.guardChecks + 1
      const checkNo = diag.guardChecks
      try {
        if (!cfg.state.guardEnabled) return next()
        const tier = effectiveExecutionTier(exec.agent)
        if (tier !== 'cheap') { diag.lastGuard = 'check' + checkNo + ': tier=' + tier + ' allow (' + agentIdentity(exec.agent) + ')'; return next() }
        const hit = isHighImpact(exec.name, exec.arguments)
        if (!hit) { diag.lastGuard = 'check' + checkNo + ': tier=build, not high-impact (' + agentIdentity(exec.agent) + ')'; return next() }
        diag.guardDenies = diag.guardDenies + 1
        diag.lastGuard = 'check' + checkNo + ': DENIED (' + agentIdentity(exec.agent) + ') ' + hit.slice(0, 60)
        return {
          kind: 'deny',
          reason: hit + ' — this high-impact action would execute on the build tier (' + tierLabel(cfg.state.cheap) + '). Escalate first: call omd_route with tier "strong" (or /omd strong), then re-issue the action.',
        }
      } catch (e) {
        diag.lastGuardError = 'check' + checkNo + ': ' + String(e && e.message || e)
        console.error('oh-my-dsh: guard failed: ' + String(e && e.message || e))
        return next()
      }
    })
  }

  // ---- tools ----------------------------------------------------------------

  function safeRegister(label, fn) {
    try {
      fn()
      return true
    } catch (e) {
      console.error('oh-my-dsh: ' + label + ' registration failed (continuing without it): ' + String(e && e.message || e))
      return false
    }
  }

  if (tools) {
    safeRegister('omd_status tool', () => tools.register(defineTool({
      name: 'omd_status',
      description: 'Report the live routing state of the Oh My DSH plugin: mode, tier configuration (think/build/vision/image), escalation state, listener counters, the effective tier computed for the calling agent, and any last routing/guard diagnostics.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { status: { type: 'string', required: true } },
        },
        render(args, value) { return [{ type: 'text', text: value.status }] },
      },
      async execute(args, exec) {
        let effective = 'unknown'
        let identity = 'unknown'
        try {
          effective = effectiveExecutionTier(exec.agent)
          identity = agentIdentity(exec.agent)
        } catch (e) {}
        let headerNow = 'none'
        try { const c = headerConfigOf(exec.agent && exec.agent.session); headerNow = c ? c.provider + '/' + c.model + '/' + (c.reasoningEffort || 'default') : 'none' } catch (e) {}
        return { status: statusText(exec.agent) + '\n  calling agent: ' + identity + '\n  effective tier for calling agent: ' + effective + '\n  current session header: ' + headerNow }
      },
    })))

    safeRegister('omd_route tool', () => tools.register(defineTool({
      name: 'omd_route',
      description: 'Set the routing mode for THIS session only (other sessions keep their own mode). strong = think tier (' + tierLabel(cfg.state.strong) + ') for hard stretches (architecture, debugging, design); cheap = build tier (' + tierLabel(cfg.state.cheap) + ') for routine implementation; auto = think while plan mode is active and build while executing; off = disable per-step routing for this session and return it to its default model.',
      parameters: {
        tier: { type: 'string', required: true, enum: ['strong', 'cheap', 'auto', 'off'], description: 'Routing tier to apply to this session.' },
        persist: { type: 'boolean', description: 'Also persist the choice as the session default model selection. Default false.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            applied: { type: 'string', required: true },
            message: { type: 'string', required: true },
          },
        },
        render(args, value) { return [{ type: 'text', text: 'Oh My DSH route (' + value.applied + '): ' + value.message }] },
      },
      async execute(args, exec) {
        return applyRoute(args.tier, args.persist === true, exec.agent)
      },
    })))

    safeRegister('omd_configure tool', () => tools.register(defineTool({
      name: 'omd_configure',
      description: 'Configure which provider/model/effort backs the think, build, and vision tiers, and the subagent policy. Any registered provider and model id work. The configuration persists in the oh-my-dsh settings namespace (pass sessionOnly: true for a transient change). Image-generation settings are edited in the oh my dsh settings tab.',
      parameters: {
        tier: { type: 'string', required: true, enum: ['strong', 'cheap', 'vision'], description: 'Which tier to configure.' },
        provider: { type: 'string', required: true, description: 'Registered provider route, e.g. "opencode-go".' },
        model: { type: 'string', required: true, description: 'Model id for that provider.' },
        reasoningEffort: { type: 'string', enum: EFFORTS, description: 'Reasoning effort for think/build tiers. Default keeps the current value.' },
        subagentPolicy: { type: 'string', enum: SUBAGENT_POLICIES, description: 'Optional: how all subagent steps route.' },
        sessionOnly: { type: 'boolean', description: 'Keep the change in-memory only (default false = persist to settings).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
          },
        },
        render(args, value) { return [{ type: 'text', text: value.message }] },
      },
      async execute(args, exec) {
        return applyConfigure(args, exec.agent)
      },
    })))

    safeRegister('omd_advisor tool', () => tools.register(defineTool({
      name: 'omd_advisor',
      description: 'Consult the think-tier advisor model (configured as ' + tierLabel(cfg.state.strong) + ') on one hard decision before committing to an approach. Use when requirements stay ambiguous after inspection, the work implicates architecture/security/data integrity/compatibility, several root causes remain, two evidence-based attempts failed, or a high-cost judgement is needed. Provide ONE decision question plus evidence already gathered. Returns guidance to apply; implementation stays on the current model.',
      parameters: {
        question: { type: 'string', required: true, description: 'One explicit decision question.' },
        evidence: { type: 'string', description: 'Relevant facts already collected: file paths, call graphs, outputs, errors, constraints.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            advice: { type: 'string', required: true },
            ok: { type: 'boolean', required: true },
            tier: { type: 'string', required: true },
            provider: { type: 'string', required: true },
            model: { type: 'string', required: true },
          },
        },
        render(args, value) {
          const head = value.ok ? 'Oh My DSH advisor (' + value.provider + '/' + value.model + '):' : 'Advisor call failed (' + value.provider + '/' + value.model + '):'
          return [{ type: 'text', text: head + '\n' + value.advice }]
        },
      },
      async execute(args, exec) {
        const user = 'Decision question:\n' + args.question + (args.evidence ? '\n\nEvidence:\n' + args.evidence : '')
        const result = await streamText(cfg.state.strong, ADVISOR_SYSTEM, user, exec.signal)
        return { advice: result.text, ok: result.ok, tier: 'think', provider: cfg.state.strong.provider, model: cfg.state.strong.model }
      },
    })))

    safeRegister('omd_review tool', () => tools.register(defineTool({
      name: 'omd_review',
      description: 'Independent think-tier review (configured as ' + tierLabel(cfg.state.strong) + ') before declaring a task complete or merging high-risk changes. Pass the exact change set, validation commands and results, and the review focus. Returns a verdict and issues ranked by severity.',
      parameters: {
        focus: { type: 'string', required: true, description: 'What is being reviewed: the change set, files, and the risk being checked.' },
        evidence: { type: 'string', description: 'Validation results, diffs, command outputs, acceptance criteria.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            verdict: { type: 'string', required: true },
            review: { type: 'string', required: true },
            ok: { type: 'boolean', required: true },
            tier: { type: 'string', required: true },
            provider: { type: 'string', required: true },
            model: { type: 'string', required: true },
          },
        },
        render(args, value) {
          const head = value.ok ? 'Oh My DSH review (' + value.provider + '/' + value.model + '): ' + value.verdict : 'Review call failed (' + value.provider + '/' + value.model + '):'
          return [{ type: 'text', text: head + '\n' + value.review }]
        },
      },
      async execute(args, exec) {
        const user = 'Review focus:\n' + args.focus + (args.evidence ? '\n\nEvidence:\n' + args.evidence : '')
        const result = await streamText(cfg.state.strong, REVIEW_SYSTEM, user, exec.signal)
        let verdict = 'FAILED'
        if (result.ok) {
          const first = String(result.text).split('\n')[0] || ''
          const match = first.match(/APPROVE|NEEDS-CHANGES|BLOCKED/i)
          verdict = match ? match[0].toUpperCase() : 'UNPARSED'
        }
        return { verdict, review: result.text, ok: result.ok, tier: 'think', provider: cfg.state.strong.provider, model: cfg.state.strong.model }
      },
    })))

    safeRegister('omd_image tool', () => tools.register(defineTool({
      name: 'omd_image',
      description: 'Generate images with the configured image model (currently ' + cfg.state.image.model + (cfg.state.image.provider ? ' via provider ' + cfg.state.image.provider : ' via a custom endpoint') + '; configure it in the oh my dsh settings tab). The model is called like a regular chat model that can emit images, and the generated images are saved under ./' + cfg.state.image.outDir + '/ with the absolute paths returned.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'The image prompt to send to the image model. Mention the desired size in the prompt, or let the model decide.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            count: { type: 'integer', required: true },
            paths: { type: 'array', items: { type: 'string' }, required: true },
            message: { type: 'string', required: true },
          },
        },
        render(args, value) { return [{ type: 'text', text: value.message }] },
      },
      async execute(args, exec) {
        return generateImages(String(args.prompt || ''), {}, exec.signal)
      },
    })))

    safeRegister('omd_worker tool', () => tools.register(defineTool({
      name: 'omd_worker',
      description: 'Delegate a bounded task packet to a fresh subagent that runs on a chosen tier: cheap (build tier, ' + tierLabel(cfg.state.cheap) + ') for routine implementation, or strong (think tier, ' + tierLabel(cfg.state.strong) + ') for hard analysis. Optional: outputSchema for a structured result, toolFilter to restrict the worker tools, maxDepth to cap delegation depth, persona to override the worker\'s system persona, background to run via the jobs service. Returns the worker\'s final output (or structured result) and stop reason.',
      parameters: {
        task: { type: 'string', required: true, description: 'Complete self-contained task packet for the worker: objective, in-scope/out-of-scope, constraints, expected return.' },
        tier: { type: 'string', enum: ['cheap', 'strong'], description: 'Tier the worker subagent runs on. Default cheap.' },
        provider: { type: 'string', description: 'Subagent provider name. Default: the first registered provider.' },
        outputSchema: { type: 'json', description: 'Optional object-rooted JSON Schema (supported subset) for a structured result.' },
        toolFilter: { type: 'json', description: 'Optional ToolRestriction object { allow?: string[], deny?: string[] }.' },
        maxDepth: { type: 'integer', description: 'Optional absolute delegation-depth cap for the worker and its descendants.' },
        persona: { type: 'string', description: 'Optional per-child persona.' },
        background: { type: 'boolean', description: 'Run the worker as a background job instead of blocking. Requires the jobs service.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            output: { type: 'string', required: true },
            structured: { type: 'json' },
            stopReason: { type: 'string', required: true },
            tier: { type: 'string', required: true },
            provider: { type: 'string', required: true },
            model: { type: 'string', required: true },
            background: { type: 'boolean' },
            jobId: { type: 'string' },
          },
        },
        render(args, value) {
          const head = 'Oh My DSH worker (' + value.tier + ' tier, ' + value.provider + '/' + value.model + ', ' + value.stopReason + '):'
          const body = value.structured !== undefined ? 'structured=' + JSON.stringify(value.structured).slice(0, 200) : value.output
          return [{ type: 'text', text: head + '\n' + body }]
        },
      },
      async execute(args, exec) {
        if (!subagents) throw new Error('omd_worker: subagents service is not mounted')
        const names = subagents.list()
        const providerName = args.provider || (names.length > 0 ? names[0] : null)
        if (!providerName) throw new Error('omd_worker: no subagent provider registered')
        const tierName = args.tier === 'strong' ? 'strong' : 'cheap'
        const tier = cfg.state[tierName]
        if (availableProviders().indexOf(tier.provider) === -1) {
          throw new Error('omd_worker: provider "' + tier.provider + '" is not registered. Registered: ' + availableProviders().join(', '))
        }
        const parent = exec.agent
        if (!parent) throw new Error('omd_worker: requires a calling agent')
        const request = {
          label: String(args.task).slice(0, 100),
          prompt: [{ type: 'text', text: String(args.task) }],
          parent,
          agentOptions: { provider: tier.provider, model: tier.model },
          signal: exec.signal,
        }
        if (args.outputSchema && typeof args.outputSchema === 'object' && !Array.isArray(args.outputSchema)) request.outputSchema = args.outputSchema
        if (args.toolFilter && typeof args.toolFilter === 'object' && !Array.isArray(args.toolFilter)) request.toolFilter = args.toolFilter
        if (typeof args.maxDepth === 'number' && Number.isInteger(args.maxDepth) && args.maxDepth >= 0) request.maxDepth = args.maxDepth
        if (args.persona && typeof args.persona === 'string') request.persona = args.persona

        const settleRun = async (run) => {
          if (run && run.localAgent && run.localAgent !== parent) childTiers.set(run.localAgent, tierName)
          let result = null
          try {
            result = await run.result
          } finally {
            try { await run.dispose() } catch (e) {}
          }
          const out = []
          if (result && Array.isArray(result.output)) {
            for (const block of result.output) {
              if (block && block.type === 'text' && typeof block.text === 'string') out.push(block.text)
            }
          }
          const res = {
            output: out.join('\n').trim(),
            stopReason: result ? String(result.stopReason) : 'unknown',
            tier: tierName,
            provider: tier.provider,
            model: tier.model,
          }
          if (result && result.structured !== undefined) res.structured = result.structured
          return res
        }

        if (args.background === true && jobs) {
          const controller = new AbortController()
          const jobId = jobs.start({
            kind: 'subagent',
            label: String(args.task).slice(0, 100),
            owner: parent,
            run: () => ({
              cancel: (reason) => { controller.abort(reason ?? 'omd_worker background job killed') },
              done: (async () => {
                try {
                  const run = await subagents.start(providerName, { ...request, signal: controller.signal })
                  const res = await settleRun(run)
                  return { status: 'completed', detail: 'tier=' + res.tier + ' model=' + res.provider + '/' + res.model + ' stopReason=' + res.stopReason, output: res.structured !== undefined ? 'structured=' + JSON.stringify(res.structured) : res.output }
                } catch (e) {
                  return { status: controller.signal.aborted ? 'killed' : 'failed', detail: String(e && e.message || e) }
                }
              })(),
            }),
          })
          return { output: 'started background worker', stopReason: 'background', tier: tierName, provider: tier.provider, model: tier.model, background: true, jobId: String(jobId) }
        }
        if (args.background === true && !jobs) {
          throw new Error('omd_worker: background mode requested but the jobs service is not mounted')
        }

        const run = await subagents.start(providerName, request)
        return settleRun(run)
      },
    })))
  }

  // ---- stream helper (used by advisor/review) --------------------------------

  let msgSeq = 0
  async function streamText(tier, system, userText, signal) {
    if (!llm || typeof llm.stream !== 'function') return { text: 'llm service unavailable', ok: false }
    if (availableProviders().indexOf(tier.provider) === -1) {
      return { text: 'provider "' + tier.provider + '" is not registered in this process. Registered: ' + availableProviders().join(', '), ok: false }
    }
    const options = {
      provider: tier.provider,
      model: tier.model,
      ...(tier.effort ? { reasoningEffort: tier.effort } : {}),
      system,
      messages: [{
        id: 'omd-msg-' + (++msgSeq) + '-' + Date.now(),
        role: 'user',
        content: [{ type: 'text', text: userText }],
        source: { kind: 'user' },
      }],
      signal,
    }
    let text = ''
    let finish = null
    try {
      for await (const chunk of llm.stream(options)) {
        if (chunk && chunk.type === 'text-delta') text += chunk.text
        else if (chunk && chunk.type === 'finish') finish = chunk.reason
      }
    } catch (e) {
      finish = { kind: 'error', failure: { message: String(e && e.message || e) } }
    }
    if (!finish) finish = { kind: 'error', failure: { message: 'stream ended without a finish chunk' } }
    if (finish.kind === 'stop' && text.trim().length > 0) return { text: text.trim(), ok: true, truncated: false }
    if (finish.kind === 'max-tokens' && text.trim().length > 0) return { text: text.trim() + '\n[truncated by max-tokens]', ok: true, truncated: true }
    if (finish.kind === 'aborted') return { text: 'Call was aborted.', ok: false }
    return { text: 'Call failed: ' + String(finish.failure && finish.failure.message || finish.kind), ok: false }
  }

  // ---- prompt section --------------------------------------------------------

  if (systemPrompt) {
    safeRegister('prompt section', () => systemPrompt.section({
      name: 'oh-my-dsh',
      order: 120,
      text: function () {
        const c = cfg.state
        return [
          '## Oh My DSH — tiered model routing',
          'This session uses tiered routing: think = ' + tierLabel(c.strong) + '; build = ' + tierLabel(c.cheap) + '; vision = ' + tierLabel(c.vision) + ' (auto ' + (c.visionAuto ? 'on' : 'off') + '). Global routing default: ' + c.mode + ' (a per-session override may apply in this session); subagent policy: ' + c.subagentPolicy + '.',
          '',
          '### /omd commands',
          'When a user message starts with "/omd " (slash omd + space), treat it as an Oh My DSH command. Parse the subcommand and execute it using the corresponding omd_* tool below. Always respond with the tool output.',
          '- `/omd status` — call `omd_status` and show the output.',
          '- `/omd strong` or `/omd think` — call `omd_route` with tier "strong".',
          '- `/omd cheap` or `/omd build` — call `omd_route` with tier "cheap".',
          '- `/omd auto` — call `omd_route` with tier "auto".',
          '- `/omd off` — call `omd_route` with tier "off".',
          '- `/omd plan` — set routing to auto and enter plan mode.',
          '- `/omd models` — call `omd_status` (it shows registered providers and models).',
          '- `/omd set think <provider> <model> [effort]` — call `omd_configure` with tier "strong".',
          '- `/omd set build <provider> <model> [effort]` — call `omd_configure` with tier "cheap".',
          '- `/omd set vision <provider> <model>` — call `omd_configure` with tier "vision".',
          '- `/omd subagent <inherit|cheap|strong>` — call `omd_configure` with the policy.',
          '- Automatic vision description (visionAuto) is a settings-tab toggle; the describing model itself is set with `/omd set vision <provider> <model>`.',
          '- `/omd advisor <question>` — call `omd_advisor` with the question.',
          '- `/omd review <focus>` — call `omd_review` with the focus.',
          '- `/omd image <prompt>` — call `omd_image` with the prompt (mention desired size in the prompt or let the model decide).',
          '- `/omd` alone — call `omd_status`.',
          '',
          '### Routing behavior',
          '- In auto mode, the session model follows plan state: plan mode runs on the think tier, execution on the build tier (applied when a new message arrives or plan mode flips).',
          '- Image messages: the vision model (' + tierLabel(c.vision) + ') describes the image in the background; the working tier answers from that description (the image stays in the chat, the session model never switches for an image).',
          (c.guardEnabled ? '- A deterministic guard denies high-impact tool calls (rm -rf, sudo, force push, credential/secret file edits, ...) while the build tier executes: call `omd_route` with tier "strong" first, then re-issue the action.' : '- The high-impact guard is currently disabled in the oh-my-dsh settings.'),
          '- Repeated model-step errors automatically escalate the session to the think tier for a few minutes (failure auto-escalation; inactive in off mode).',
          '- Delegate bounded implementation packets to `omd_worker` (build tier by default; use tier "strong" for hard analysis).',
          '- Before committing to an approach, call `omd_advisor` with ONE decision question plus gathered evidence when the decision is hard or risky.',
          '- Call `omd_review` before declaring a high-risk task complete: pass the exact change set and validation results.',
          '- Generate images with `omd_image` (the configured image model ' + c.image.model + ' saves files under ./' + c.image.outDir + '/).',
          '- Use `omd_route` to switch tiers for a stretch of work; use `omd_configure` to change which provider/model backs each tier; use `omd_status` to inspect routing state.',
          '- Never claim a tier or model ran unless a tool result or step header identifies it.',
        ].join('\n')
      },
    }))
  }

  console.log('oh-my-dsh: agent plane active — mode=' + cfg.state.mode + ' think=' + tierLabel(cfg.state.strong) + ' build=' + tierLabel(cfg.state.cheap) + ' vision=' + tierLabel(cfg.state.vision) + ' image=' + cfg.state.image.model)
}

/** Preset-row entry point (Web sessions): same activation, own config load. */
export function apply(ctx) {
  const cfg = loadConfig(ctx)
  cfg.readFresh()
  activateAgentPlane(ctx, cfg)
}
