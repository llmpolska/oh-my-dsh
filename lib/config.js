// Shared configuration for oh-my-dsh: the `oh-my-dsh` settings namespace
// schema, the resolved in-memory state, and the first-boot adoption that
// points the tiers at models that actually exist in this process.
//
// Exactly one fiber registers the namespace (settings.register throws on the
// second registration); whoever mounts second reads through describe().

import z from '@deepseek-ai/schemastery'

export const OMD_NAMESPACE = 'oh-my-dsh'

export const EFFORTS = ['off', 'high', 'max']
export const MODES = ['auto', 'strong', 'cheap', 'off']
export const SUBAGENT_POLICIES = ['inherit', 'cheap', 'strong']

export const omdSchema = z.object({
  mode: z.union(['auto', 'strong', 'cheap', 'off']).default('auto'),
  strongProvider: z.string().default(''),
  strongModel: z.string().default(''),
  strongEffort: z.union(['off', 'high', 'max']).default('max'),
  cheapProvider: z.string().default(''),
  cheapModel: z.string().default(''),
  cheapEffort: z.union(['off', 'high', 'max']).default('high'),
  visionProvider: z.string().default(''),
  visionModel: z.string().default(''),
  visionAuto: z.boolean().default(true),
  subagentPolicy: z.union(['inherit', 'cheap', 'strong']).default('inherit'),
  guardEnabled: z.boolean().default(true),
  escalateThreshold: z.number().default(2),
  escalateWindowSec: z.number().default(60),
  escalateTtlSec: z.number().default(180),
  imageProvider: z.string().default('openai'),
  imageBaseUrl: z.string().default('https://api.openai.com/v1'),
  imageModel: z.string().default('gpt-image-1'),
  imageApiKeyEnv: z.string().default('OPENAI_API_KEY'),
  imageApiKey: z.string().default(''),
  imageSize: z.string().default('1024x1024'),
  imageUseModalities: z.boolean().default(true),
  imageOutDir: z.string().default('oh-my-dsh-images'),
})

/** Read the flat settings view into the runtime state shape. */
export function stateFromView(view) {
  const v = view || {}
  return {
    mode: v.mode ?? 'auto',
    strong: { provider: v.strongProvider ?? '', model: v.strongModel ?? '', effort: v.strongEffort ?? 'max' },
    cheap: { provider: v.cheapProvider ?? '', model: v.cheapModel ?? '', effort: v.cheapEffort ?? 'high' },
    vision: { provider: v.visionProvider ?? '', model: v.visionModel ?? '' },
    visionAuto: v.visionAuto !== false,
    subagentPolicy: v.subagentPolicy ?? 'inherit',
    guardEnabled: v.guardEnabled !== false,
    escalateThreshold: typeof v.escalateThreshold === 'number' ? v.escalateThreshold : 2,
    escalateWindowMs: (typeof v.escalateWindowSec === 'number' ? v.escalateWindowSec : 60) * 1000,
    escalateTtlMs: (typeof v.escalateTtlSec === 'number' ? v.escalateTtlSec : 180) * 1000,
    image: {
      provider: v.imageProvider ?? 'openai',
      baseUrl: v.imageBaseUrl ?? 'https://api.openai.com/v1',
      model: v.imageModel ?? 'gpt-image-1',
      apiKeyEnv: v.imageApiKeyEnv ?? 'OPENAI_API_KEY',
      apiKey: v.imageApiKey ?? '',
      size: v.imageSize ?? '1024x1024',
      useModalities: v.imageUseModalities !== false,
      outDir: v.imageOutDir ?? 'oh-my-dsh-images',
    },
  }
}

/** Flatten the runtime state back to the settings view. */
export function viewFromState(state) {
  return {
    mode: state.mode,
    strongProvider: state.strong.provider,
    strongModel: state.strong.model,
    strongEffort: state.strong.effort,
    cheapProvider: state.cheap.provider,
    cheapModel: state.cheap.model,
    cheapEffort: state.cheap.effort,
    visionProvider: state.vision.provider,
    visionModel: state.vision.model,
    visionAuto: state.visionAuto,
    subagentPolicy: state.subagentPolicy,
    guardEnabled: state.guardEnabled,
    escalateThreshold: state.escalateThreshold,
    escalateWindowSec: Math.round(state.escalateWindowMs / 1000),
    escalateTtlSec: Math.round(state.escalateTtlMs / 1000),
    imageProvider: state.image.provider,
    imageBaseUrl: state.image.baseUrl,
    imageModel: state.image.model,
    imageApiKeyEnv: state.image.apiKeyEnv,
    imageApiKey: state.image.apiKey,
    imageSize: state.image.size,
    imageUseModalities: state.image.useModalities,
    imageOutDir: state.image.outDir,
  }
}

/**
 * Mount the shared config for one fiber. The first caller registers the
 * settings namespace and owns persistence; later callers (the agent-preset
 * row) attach to the same namespace through describe()/update().
 * @param ctx - cordis context.
 * @returns { state, get(), update(patch), watch(cb), registered }
 */
export function loadConfig(ctx) {
  const settings = ctx.get('settings')
  const cfg = {
    state: stateFromView(null),
    registered: false,
    scope: null,
    watchers: new Set(),
    get() { return cfg.state },
    update(patch) {
      if (typeof patch !== 'object' || patch === null) return Promise.resolve(false)
      if (!settings) return Promise.resolve(false)
      if (cfg.scope) return cfg.scope.update(patch).then(() => true).catch(() => false)
      return Promise.resolve(settings.update(OMD_NAMESPACE, patch)).then(() => true).catch((e) => {
        console.error('oh-my-dsh: settings update failed: ' + String(e && e.message || e))
        return false
      })
    },
    applyView(view) {
      cfg.state = stateFromView(view)
      for (const w of cfg.watchers) { try { w(cfg.state) } catch (e) {} }
    },
    watch(cb) { cfg.watchers.add(cb); return () => cfg.watchers.delete(cb) },
    /** Start periodic describe() re-reads (for fibers that cannot own the scope watch). */
    startPolling(intervalMs = 5000) {
      if (cfg.poll) return cfg.poll
      const timer = setInterval(() => cfg.readFresh(), intervalMs)
      if (typeof timer.unref === 'function') timer.unref()
      cfg.poll = () => { clearInterval(timer); cfg.poll = null }
      return cfg.poll
    },
    readFresh() {
      if (!settings || typeof settings.describe !== 'function') return
      try {
        const desc = settings.describe({ redactSecrets: false }).find((d) => d.ns === OMD_NAMESPACE)
        if (desc && desc.value) cfg.applyView(desc.value)
      } catch (e) { /* namespace not yet registered */ }
    },
  }
  if (settings && typeof settings.register === 'function') {
    try {
      cfg.scope = settings.register(OMD_NAMESPACE, omdSchema)
      cfg.registered = true
      const saved = cfg.scope.get()
      if (saved) cfg.applyView(saved)
      cfg.scope.watch((next) => cfg.applyView(next))
    } catch (e) {
      // Already registered by the other half (host vs preset) — attach via
      // describe and stay attached through periodic re-reads (the owning
      // half's scope watch only reaches its own fiber).
      console.log('oh-my-dsh: settings namespace already registered — attaching read-only (' + String(e && e.message || e) + ')')
      cfg.readFresh()
      cfg.startPolling()
    }
  }
  return cfg
}
