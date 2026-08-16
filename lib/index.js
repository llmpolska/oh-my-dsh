// oh-my-dsh — the host half.
//
// Mounted on the host plane by the bundle patch. What it contributes depends
// on the surface it boots on:
//
//   Web (Desktop)   registers the `oh-my-dsh` settings namespace, installs
//                   the shipped agent preset into $DSH_HOME/.agent-presets
//                   (and adopts it as the default preset when the default is
//                   still `standard`), serves the /omd configuration endpoint
//                   the settings tab talks to, and pre-admits image prompts to
//                   the configured vision model.
//   TUI / headless  no preset roster exists, so the agent-plane contributions
//                   activate process-wide right here (single-session agent in
//                   the root realm).

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { activateAgentPlane } from './agent.js'
import { OMD_NAMESPACE, loadConfig, omdSchema, viewFromState, visionDescriptionStore, visionImageHash } from './config.js'
import { builtinImageModel, builtinImageModels, llmPiProviderSection, resolveImageRoute } from './image-route.js'

export const name = 'oh-my-dsh'

const WRAPPED = Symbol.for('oh-my-dsh.prompt.wrapped')

const PRESET_FILES = ['agent.cordis.yml', 'preset.yml']
const PRESET_ID = 'oh-my-dsh'

/** Builtin pi-ai providers that carry a "luna"-style image-generating chat model. */
const BUILTIN_LUNA_PROVIDERS = ['openai-codex', 'opencode', 'openai', 'openrouter']

export const inject = ['settings']

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function log(...args) {
  console.log('oh-my-dsh: ' + args.join(' '))
}

// ---- first-boot adoption ---------------------------------------------------
// Point the tiers at models that actually exist in this process instead of
// leaving the configured defaults empty: strong/cheap adopt the session
// default model, vision adopts the first image-capable model of the first
// registered provider. Only empty or unregistered fields are touched.

async function firstModelOf(llm, provider) {
  try {
    const models = await llm.listModels(provider)
    return (models && models[0] && models[0].id) || ''
  } catch (e) { return '' }
}

async function firstVisionModelOf(llm, provider) {
  try {
    const models = await llm.listModels(provider)
    for (const m of (models || [])) {
      if (m && Array.isArray(m.inputModalities) && m.inputModalities.indexOf('image') !== -1) {
        return { model: m.id, provider }
      }
    }
    return null
  } catch (e) { return null }
}

export async function adoptRuntimeDefaults(ctx, cfg) {
  const llm = ctx.get('llm')
  const adm = ctx.get('agentDefaultModel')
  const settings = ctx.get('settings')
  if (!llm || typeof llm.listProviders !== 'function') return false
  // Only adopt on a pristine namespace: once the user has persisted any
  // value (settings tab or /omd set), never clobber their choices.
  if (settings && typeof settings.describe === 'function') {
    try {
      const desc = settings.describe({ redactSecrets: false }).find((d) => d.ns === OMD_NAMESPACE)
      if (desc && desc.user && Object.keys(desc.user).length > 0) return true
    } catch (e) { /* treat as pristine */ }
  }
  // The settings-file provider loads settings.yaml asynchronously; the
  // agent-default-model user layer (the session default the tiers adopt)
  // may not be readable yet. Read it from describe() and report readiness
  // so the caller can retry shortly.
  let defSel = null
  try { defSel = adm && adm.currentSelection ? adm.currentSelection() : null } catch (e) {}
  if (settings && typeof settings.describe === 'function') {
    try {
      const desc = settings.describe({ redactSecrets: false }).find((d) => d.ns === 'agent-default-model')
      const user = desc && desc.user
      if (user && typeof user.provider === 'string' && user.provider && typeof user.model === 'string' && user.model) {
        defSel = { provider: user.provider, model: user.model, reasoningEffort: user.reasoningEffort }
      } else if (!defSel) {
        return false // not ready yet — retry
      }
    } catch (e) { /* fall through to currentSelection */ }
  }
  let providers = []
  try { providers = (llm.listProviders() || []).map((p) => p.id) } catch (e) { return false }
  if (providers.length === 0) return false
  const first = providers[0]
  const defProvider = (defSel && defSel.provider && providers.indexOf(defSel.provider) !== -1) ? defSel.provider : first
  const defModel = (defSel && defSel.provider === defProvider && defSel.model) || ''
  const s = cfg.state
  const changed = { fields: [] }

  s.strong.provider = defProvider
  s.strong.model = defModel || await firstModelOf(llm, defProvider)
  if (s.strong.model) changed.fields.push('think=' + s.strong.provider + '/' + s.strong.model)
  s.cheap.provider = defProvider
  s.cheap.model = defModel || await firstModelOf(llm, defProvider)
  if (s.cheap.model) changed.fields.push('build=' + s.cheap.provider + '/' + s.cheap.model)

  // Prefer the session-default provider, then scan every provider for the
  // first image-capable model.
  let vis = await firstVisionModelOf(llm, defProvider)
  if (!vis) {
    for (const p of providers) {
      vis = await firstVisionModelOf(llm, p)
      if (vis) break
    }
  }
  if (vis) {
    s.vision.provider = vis.provider
    s.vision.model = vis.model
    changed.fields.push('vision=' + vis.provider + '/' + vis.model)
  }
  // Image generation: hook the ordinary chat model of the session-default
  // provider (e.g. gpt-5.6-luna on opencode-go) instead of a separate image
  // endpoint. Base URL and API key resolve from the provider's own route.
  if (!s.image.provider) {
    s.image.provider = defProvider
    const luna = await builtinImageModel(defProvider, 'gpt-5.6-luna')
    s.image.model = luna ? 'gpt-5.6-luna' : (s.image.model || 'gpt-5.6-luna')
    const section = llmPiProviderSection(ctx.get('settings'), defProvider)
    if (section && section.apiKeyEnv) s.image.apiKeyEnv = String(section.apiKeyEnv)
    changed.fields.push('image=' + s.image.model + ' via ' + defProvider)
  }
  if (changed.fields.length > 0) {
    const ok = await cfg.update(viewFromState(s))
    log('first-boot adoption: ' + changed.fields.join(', ') + (ok ? ' (persisted)' : ' (persist failed)'))
  }
  return true
}

/** Run adoption with a bounded retry until the settings file has loaded. */
export function scheduleAdoption(ctx, cfg) {
  let attempts = 0
  const attempt = async () => {
    attempts = attempts + 1
    let done = false
    try { done = await adoptRuntimeDefaults(ctx, cfg) } catch (e) { console.error('oh-my-dsh: adoption failed: ' + String(e && e.message || e)) }
    if (!done && attempts < 20) setTimeout(attempt, 500)
  }
  setTimeout(attempt, 250)
}

// ---- agent preset installation (Web) ---------------------------------------

function ensurePresetInstalled(ctx) {
  const pkgDir = dirname(fileURLToPath(import.meta.url))
  const srcDir = join(pkgDir, '..', 'agent-presets', PRESET_ID)
  const targetDir = join(dshHome(), '.agent-presets', PRESET_ID)
  // The preset composes against a base URL that cannot resolve the plugin
  // package by name (the loader imports preset rows relative to the preset
  // directory). Point the omd-routing row at this package's own agent.js
  // via an absolute file URL so the import works from any base.
  const agentEntry = pathToFileURL(join(pkgDir, 'agent.js')).href
  try {
    let version = ''
    try { version = String(JSON.parse(readFileSync(join(pkgDir, '..', 'package.json'), 'utf8')).version || '') } catch (e) {}
    const stampPath = join(targetDir, '.source-version')
    let stamp = ''
    try { stamp = readFileSync(stampPath, 'utf8').trim() } catch (e) {}
    if (!existsSync(targetDir) || version && stamp !== version) {
      mkdirSync(targetDir, { recursive: true })
      let copied = 0
      for (const f of PRESET_FILES) {
        const src = join(srcDir, f)
        if (!existsSync(src)) continue
        if (f === 'agent.cordis.yml') {
          const template = readFileSync(src, 'utf8')
          const rewritten = template.replace(/name: oh-my-dsh\/agent/, 'name: ' + agentEntry)
          writeFileSync(join(targetDir, f), rewritten, 'utf8')
        } else {
          copyFileSync(src, join(targetDir, f))
        }
        copied = copied + 1
      }
      if (version) writeFileSync(stampPath, version + '\n')
      if (copied > 0) log('installed/refreshed the "' + PRESET_ID + '" agent preset in ' + targetDir + ' (v' + version + ', entry ' + agentEntry + ')')
    }
    adoptPresetAsDefault(ctx)
  } catch (e) {
    console.error('oh-my-dsh: preset install failed: ' + String(e && e.message || e))
  }
}

function adoptPresetAsDefault(ctx) {
  const settings = ctx.get('settings')
  if (!settings || typeof settings.describe !== 'function' || typeof settings.update !== 'function') return
  try {
    const desc = settings.describe({ redactSecrets: true }).find((d) => d.ns === 'agent-presets')
    if (desc && desc.value && desc.value.default === 'standard') {
      settings.update('agent-presets', { default: PRESET_ID }).then(
        () => log('default agent preset adopted: ' + PRESET_ID + ' (was standard)'),
        (e) => console.error('oh-my-dsh: default preset adoption failed: ' + String(e && e.message || e)),
      )
    }
  } catch (e) {
    console.error('oh-my-dsh: default preset adoption failed: ' + String(e && e.message || e))
  }
}

// ---- /omd configuration endpoint (Web) --------------------------------------

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1 << 20) { rejectBody(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
  })
}

function respondJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function validatePatch(fields) {
  const out = {}
  const enums = {
    mode: ['auto', 'strong', 'cheap', 'off'],
    strongEffort: ['off', 'high', 'max'],
    cheapEffort: ['off', 'high', 'max'],
    subagentPolicy: ['inherit', 'cheap', 'strong'],
  }
  const strings = [
    'strongProvider', 'strongModel', 'cheapProvider', 'cheapModel',
    'visionProvider', 'visionModel',
    'imageProvider', 'imageBaseUrl', 'imageModel', 'imageApiKeyEnv', 'imageApiKey', 'imageSize', 'imageOutDir',
  ]
  const booleans = ['visionAuto', 'guardEnabled', 'imageUseModalities']
  const numbers = ['escalateThreshold', 'escalateWindowSec', 'escalateTtlSec']
  for (const key of Object.keys(fields)) {
    const value = fields[key]
    if (enums[key]) {
      if (enums[key].indexOf(value) === -1) throw new Error('invalid value for ' + key)
      out[key] = value
    } else if (strings.indexOf(key) !== -1) {
      if (typeof value !== 'string' || value.length > 512) throw new Error('invalid value for ' + key)
      out[key] = value
    } else if (booleans.indexOf(key) !== -1) {
      if (typeof value !== 'boolean') throw new Error('invalid value for ' + key)
      out[key] = value
    } else if (numbers.indexOf(key) !== -1) {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 1 || n > 86400) throw new Error('invalid value for ' + key)
      out[key] = n
    } else {
      throw new Error('unknown field ' + key)
    }
  }
  return out
}

function registerEndpoint(ctx, webServer, cfg) {
  const llm = ctx.get('llm')
  let catalogCache = null
  let catalogCacheAt = 0
  async function catalogView() {
    const now = Date.now()
    if (catalogCache && now - catalogCacheAt < 10000) return catalogCache
    const providers = []
    const models = {}
    const visionModels = []
    if (llm && typeof llm.listProviders === 'function') {
      try {
        for (const p of (llm.listProviders() || [])) {
          const id = String(p.id || p.name || '')
          if (!id) continue
          providers.push({ id, name: String(p.name || id) })
          models[id] = []
          try {
            const list = await llm.listModels(id)
            for (const m of (list || [])) {
              const inputModalities = Array.isArray(m.inputModalities) ? m.inputModalities.slice() : []
              models[id].push({ id: m.id, name: m.name || m.id, ...(inputModalities.length > 0 ? { inputModalities } : {}) })
              if (inputModalities.indexOf('image') !== -1) visionModels.push({ provider: id, id: m.id, name: m.name || m.id })
            }
          } catch (e) { /* catalog advisory */ }
        }
      } catch (e) { /* no llm service */ }
    }
    catalogCache = { providers, models, visionModels }
    catalogCacheAt = now
    return catalogCache
  }
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/omd',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          const catalog = await catalogView()
          const route = await resolveImageRoute(ctx, cfg.state.image)
          const builtin = []
          for (const p of BUILTIN_LUNA_PROVIDERS) {
            try {
              const models = await builtinImageModels(p)
              if (models.some((m) => /luna/i.test(String(m.id || ''))) && !catalog.providers.some((r) => r.id === p)) builtin.push({ id: p, name: p, builtin: true })
            } catch (e) {}
          }
          return respondJson(res, 200, {
            ok: true,
            config: viewFromState(cfg.state),
            providers: catalog.providers,
            models: catalog.models,
            visionModels: catalog.visionModels,
            imageProviders: [
              ...catalog.providers.map((p) => ({ id: p.id, name: p.name, builtin: false })),
              ...builtin,
            ],
            imageRoute: {
              provider: route.provider,
              model: route.model,
              baseUrl: route.baseUrl,
              api: route.api,
              keyEnv: route.keyEnv,
              keyConfigured: route.apiKey.length > 0,
            },
          })
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          let fields
          try { fields = JSON.parse(body || '{}') } catch (e) { return respondJson(res, 400, { ok: false, message: 'invalid JSON body' }) }
          try {
            const patch = validatePatch(fields)
            const saved = await cfg.update(patch)
            if (!saved) return respondJson(res, 500, { ok: false, message: 'settings update failed (settings service unavailable?)' })
            return respondJson(res, 200, { ok: true, config: viewFromState(cfg.state) })
          } catch (e) {
            return respondJson(res, 400, { ok: false, message: String(e && e.message || e) })
          }
        }
        res.writeHead(405, { allow: 'GET, POST' })
        res.end()
      } catch (e) {
        try { respondJson(res, 500, { ok: false, message: String(e && e.message || e) }) } catch (e2) {}
      }
    },
  }), 'oh-my-dsh: /omd endpoint')
}

// ---- vision describe (Web) --------------------------------------------------
// Production semantics (omp-style): the vision model ONLY describes images —
// it never runs a turn. The working tier (think/build) answers from the
// description, so "build a frontend like this image" is built by the working
// model with full image context as text.
// The api-proxy rejects an image prompt when the session's current selection
// lacks the image modality BEFORE the message reaches the inbox. The image
// must stay in the message (the chat keeps showing it), so this wrapper
// briefly routes the header to the vision model — only to pass that gate; the
// inbox listener routes the turn back to the working tier before any request
// is built, and a background vision description (keyed by image sha256) is
// queued for the agent-plane scrub, which substitutes it for the image part
// in text-only model requests.

function headerConfigOf(session) {
  try {
    const h = session && session.requestHeader ? session.requestHeader() : undefined
    return h ? h.config : undefined
  } catch (e) { return undefined }
}

// ---- background vision description ------------------------------------------
// Queued at admission, resolved while the working model's first request is
// being built; the scrub awaits it, so the answer starts with the description
// in context without blocking prompt acceptance.

const VISION_DESCRIBE_SYSTEM = [
  'You are the vision role of a coding agent.',
  'Describe the attached image(s) precisely and completely for a text-only model that will later need to act on them: layout, all text and code verbatim, UI elements, colors, spatial relationships, and anything worth knowing.',
  'Do not answer any question in the prompt — describe only.',
].join('\n')

/** Describe the image parts with the vision model; null on failure. */
async function describeWithVision(ctx, llm, vis, content, requestSignal) {
  const imageParts = content.filter((p) => p && p.type === 'image')
  const text = content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n').trim()
  if (imageParts.length === 0) return null
  const attachments = ctx.get('attachments')
  const durableParts = []
  for (const part of imageParts) {
    try {
      if (part.attachment && attachments && typeof attachments.readImage === 'function') {
        durableParts.push({ type: 'image', attachment: part.attachment })
      } else if (typeof part.data === 'string' && part.data.length > 0 && attachments && typeof attachments.saveImage === 'function') {
        const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(part.data)
        const b64 = (m ? m[3] : part.data).replace(/\s+/g, '')
        if (b64.length === 0) continue
        const buffer = Buffer.from(b64, 'base64')
        if (buffer.length === 0) continue
        const attachment = await attachments.saveImage({
          data: buffer,
          mediaType: part.mediaType || (m && m[1]) || 'image/png',
          ...(part.name === undefined ? {} : { name: part.name }),
        })
        durableParts.push({ type: 'image', attachment })
      }
    } catch (e) {
      console.error('oh-my-dsh: vision describe part resolve failed: ' + String(e && e.message || e))
    }
  }
  if (durableParts.length === 0) return null
  const userContent = [...durableParts]
  if (text.length > 0) userContent.push({ type: 'text', text })
  let signal = requestSignal
  try {
    const timeout = AbortSignal.timeout(120000)
    if (requestSignal) {
      try { signal = AbortSignal.any([requestSignal, timeout]) } catch (e) { signal = timeout }
    } else {
      signal = timeout
    }
  } catch (e) { /* keep requestSignal as-is */ }
  let description = ''
  try {
    for await (const chunk of llm.stream({
      provider: vis.provider,
      model: vis.model,
      system: VISION_DESCRIBE_SYSTEM,
      messages: [{
        id: 'omd-vision-' + Date.now(),
        role: 'user',
        content: userContent,
        source: { kind: 'user' },
      }],
      signal,
    })) {
      if (chunk && chunk.type === 'text-delta') description += chunk.text
    }
  } catch (e) {
    console.error('oh-my-dsh: vision describe failed: ' + String(e && e.message || e))
    return null
  }
  description = description.trim()
  return description.length > 0 ? description : null
}

/**
 * Queue a background vision description per image (keyed by sha256) WITHOUT
 * blocking prompt acceptance. The stored value is a promise the agent-plane
 * scrub awaits: the working model's first request waits for the description,
 * while the chat already shows the user's message (with the image) instantly.
 */
function scheduleVisionDescription(ctx, llm, vis, content) {
  try {
    const imageParts = content.filter((p) => p && p.type === 'image')
    if (imageParts.length === 0) return
    let queued = 0
    for (const part of imageParts) {
      try {
        let buffer = null
        if (typeof part.data === 'string' && part.data.length > 0) {
          const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(part.data)
          const b64 = (m ? m[3] : part.data).replace(/\s+/g, '')
          buffer = Buffer.from(b64, 'base64')
        }
        if (!buffer || buffer.length === 0) continue
        const hash = visionImageHash(buffer)
        if (visionDescriptionStore.has(hash)) continue
        // Resolves to the description text, or null when the describe fails.
        visionDescriptionStore.set(hash, describeImagesOnce(ctx, llm, vis, content).catch((e) => {
          console.error('oh-my-dsh: background vision description failed: ' + String(e && e.message || e))
          return null
        }))
        queued = queued + 1
      } catch (e) { /* best effort */ }
    }
    if (queued > 0) log('vision description queued for ' + queued + ' image(s) via ' + vis.provider + '/' + vis.model)
  } catch (e) { /* best effort */ }
}

/** One vision describe call; resolves to the description text or rejects. */
async function describeImagesOnce(ctx, llm, vis, content) {
  const description = await describeWithVision(ctx, llm, vis, content, undefined)
  if (!description) throw new Error('vision describe returned no text')
  return description
}

function wrapPromptAdmission(ctx, cfg) {
  const llm = ctx.get('llm')
  const agents = ctx.get('agents')
  ctx.inject(['apiProxy'], (pctx) => {
    try {
      const sessions = pctx.apiProxy && pctx.apiProxy.sessions
      if (!sessions || typeof sessions.prompt !== 'function' || sessions.prompt[WRAPPED]) return
      const original = sessions.prompt.bind(sessions)
      const wrapped = async function (request) {
        try {
          const payload = request && request.payload
          const content = payload && payload.content
          if (cfg.state.visionAuto && cfg.state.mode !== 'off' && Array.isArray(content) && content.some((p) => p && p.type === 'image')) {
            const vis = cfg.state.vision
            const registered = llm && typeof llm.listProviders === 'function'
              ? (llm.listProviders() || []).some((p) => p.id === vis.provider)
              : false
            if (vis && vis.provider && vis.model && registered) {
              const agent = agents && typeof agents.get === 'function' ? agents.get(String(payload.sessionId)) : undefined
              if (agent && agent.session && typeof agent.session.append === 'function') {
                const cur = headerConfigOf(agent.session)
                if (!cur || cur.provider !== vis.provider || cur.model !== vis.model) {
                  // Gate-only route: lets the image through while the message
                  // keeps the image; the inbox listener routes the turn back
                  // to the working tier before any request is built.
                  agent.session.append('request/header', {
                    header: { config: { provider: vis.provider, model: vis.model } },
                    reason: 'change',
                  })
                  log('vision gate: ' + String(payload.sessionId) + ' -> ' + vis.provider + '/' + vis.model)
                }
              }
              // Background description for the working tier's requests.
              scheduleVisionDescription(ctx, llm, vis, content)
            }
          }
        } catch (e) {
          console.error('oh-my-dsh: vision describe wrapper failed: ' + String(e && e.message || e))
        }
        return original(request)
      }
      wrapped[WRAPPED] = true
      sessions.prompt = wrapped
      log('vision describe wrapper installed on api-proxy sessions.prompt')
    } catch (e) {
      console.error('oh-my-dsh: vision turn wrapper install failed: ' + String(e && e.message || e))
    }
  })
}

// ---- entry ----------------------------------------------------------------

export function apply(ctx) {
  const cfg = loadConfig(ctx)
  const agentPresets = ctx.get('agentPresets')
  const webServer = ctx.get('webServer')

  // Host-plane contributions on every surface.
  if (cfg.registered || ctx.get('settings')) {
    scheduleAdoption(ctx, cfg)
  }

  if (webServer) {
    registerEndpoint(ctx, webServer, cfg)
    wrapPromptAdmission(ctx, cfg)
    if (agentPresets) ensurePresetInstalled(ctx)
    log('web surface active (endpoint /omd, vision describe, preset ' + (agentPresets ? 'enabled' : 'n/a') + ')')
  } else if (!agentPresets) {
    // TUI / headless: the agent is composed process-wide in the root realm,
    // so the agent plane activates right here.
    activateAgentPlane(ctx, cfg)
  } else {
    log('agent-presets roster present without a web server — agent plane stays with the preset row')
  }
}

export { OMD_NAMESPACE, omdSchema }
