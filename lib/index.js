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
import { fileURLToPath } from 'node:url'
import { activateAgentPlane } from './agent.js'
import { OMD_NAMESPACE, loadConfig, omdSchema, viewFromState } from './config.js'

export const name = 'oh-my-dsh'

const WRAPPED = Symbol.for('oh-my-dsh.prompt.wrapped')

const PRESET_FILES = ['agent.cordis.yml', 'preset.yml']
const PRESET_ID = 'oh-my-dsh'

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
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'agent-presets', PRESET_ID)
  const targetDir = join(dshHome(), '.agent-presets', PRESET_ID)
  try {
    let version = ''
    try { version = String(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version || '') } catch (e) {}
    const stampPath = join(targetDir, '.source-version')
    let stamp = ''
    try { stamp = readFileSync(stampPath, 'utf8').trim() } catch (e) {}
    if (!existsSync(targetDir) || version && stamp !== version) {
      mkdirSync(targetDir, { recursive: true })
      let copied = 0
      for (const f of PRESET_FILES) {
        const src = join(srcDir, f)
        if (!existsSync(src)) continue
        copyFileSync(src, join(targetDir, f))
        copied = copied + 1
      }
      if (version) writeFileSync(stampPath, version + '\n')
      if (copied > 0) log('installed/refreshed the "' + PRESET_ID + '" agent preset in ' + targetDir + ' (v' + version + ')')
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
          return respondJson(res, 200, {
            ok: true,
            config: viewFromState(cfg.state),
            providers: catalog.providers,
            models: catalog.models,
            visionModels: catalog.visionModels,
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

// ---- vision admission (Web) -------------------------------------------------
// The api-proxy rejects an image prompt when the session's current selection
// lacks the image modality, BEFORE the message reaches the inbox (so the
// inbox-based routing can never fix the FIRST image message). This wrapper
// runs before that gate: when the prompt carries image parts, it writes the
// vision model into the session's request/header so the gate admits it.

function headerConfigOf(session) {
  try {
    const h = session && session.requestHeader ? session.requestHeader() : undefined
    return h ? h.config : undefined
  } catch (e) { return undefined }
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
          if (cfg.state.visionAuto && Array.isArray(content) && content.some((p) => p && p.type === 'image')) {
            const vis = cfg.state.vision
            const registered = llm && typeof llm.listProviders === 'function'
              ? (llm.listProviders() || []).some((p) => p.id === vis.provider)
              : true
            if (vis && vis.provider && vis.model && registered) {
              const agent = agents && typeof agents.get === 'function' ? agents.get(String(payload.sessionId)) : undefined
              if (agent && agent.session && typeof agent.session.append === 'function') {
                const cur = headerConfigOf(agent.session)
                if (!cur || cur.provider !== vis.provider || cur.model !== vis.model) {
                  agent.session.append('request/header', {
                    header: { config: { provider: vis.provider, model: vis.model } },
                    reason: 'change',
                  })
                  log('vision admission: ' + String(payload.sessionId) + ' -> ' + vis.provider + '/' + vis.model)
                }
              }
            }
          }
        } catch (e) {
          console.error('oh-my-dsh: vision admission wrapper failed: ' + String(e && e.message || e))
        }
        return original(request)
      }
      wrapped[WRAPPED] = true
      sessions.prompt = wrapped
      log('vision admission wrapper installed on api-proxy sessions.prompt')
    } catch (e) {
      console.error('oh-my-dsh: vision admission wrapper install failed: ' + String(e && e.message || e))
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
    log('web surface active (endpoint /omd, vision admission, preset ' + (agentPresets ? 'enabled' : 'n/a') + ')')
  } else if (!agentPresets) {
    // TUI / headless: the agent is composed process-wide in the root realm,
    // so the agent plane activates right here.
    activateAgentPlane(ctx, cfg)
  } else {
    log('agent-presets roster present without a web server — agent plane stays with the preset row')
  }
}

export { OMD_NAMESPACE, omdSchema }
