// Image-route resolution shared by the host half (settings endpoint) and the
// agent half (omd_image tool).
//
// A "provider" selection (e.g. opencode-go) resolves its base URL from the
// pi-ai builtin catalog for that provider/model and its API key from the
// credentials service (apiKeyEnv declared in the llm-pi-ai settings section)
// — no manual endpoint fields needed. An empty provider means "custom
// endpoint" mode, which uses the explicit baseUrl/apiKeyEnv/apiKey fields.

let piAiPromise = null
function piAi() {
  piAiPromise ??= import('@earendil-works/pi-ai/providers/all').catch((e) => {
    console.error('oh-my-dsh: pi-ai catalog unavailable: ' + String(e && e.message || e))
    return null
  })
  return piAiPromise
}

/** Builtin catalog entry for one provider/model, or null. */
export async function builtinImageModel(provider, model) {
  if (!provider || !model) return null
  const pi = await piAi()
  if (!pi || typeof pi.getBuiltinModel !== 'function') return null
  try {
    return pi.getBuiltinModel(provider, model) || null
  } catch (e) {
    return null
  }
}

/** Builtin catalog entries for one provider. */
export async function builtinImageModels(provider) {
  if (!provider) return []
  const pi = await piAi()
  if (!pi || typeof pi.getBuiltinModels !== 'function') return []
  try {
    return pi.getBuiltinModels(provider) || []
  } catch (e) {
    return []
  }
}

/** The llm-pi-ai settings section for one provider route, if declared. */
export function llmPiProviderSection(settings, provider) {
  if (!provider || !settings || typeof settings.describe !== 'function') return null
  try {
    const desc = settings.describe({ redactSecrets: false }).find((d) => d.ns === 'llm-pi-ai')
    const providers = desc && desc.value && desc.value.providers
    const section = providers && providers[provider]
    return section && typeof section === 'object' ? section : null
  } catch (e) {
    return null
  }
}

/** Resolve an API key from the credentials service, then the environment. */
export async function resolveApiKey(ctx, apiKeyEnv, inline) {
  if (inline) return String(inline)
  if (!apiKeyEnv) return ''
  const credentials = ctx.get('credentials')
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(apiKeyEnv)
      if (resolved && resolved.value) return String(resolved.value)
    } catch (e) { /* fall through to env */ }
  }
  return String(process.env[apiKeyEnv] || '')
}

/**
 * Resolve the wire route for the configured image model.
 * @param ctx - cordis context (settings + credentials services).
 * @param image - the image section of the runtime config.
 * @returns { provider, model, baseUrl, api, apiKey, keyEnv, size, useModalities, outDir }
 */
export async function resolveImageRoute(ctx, image) {
  const c = image || {}
  const settings = ctx.get('settings')
  const section = llmPiProviderSection(settings, c.provider)
  const keyEnv = String((section && section.apiKeyEnv) || c.apiKeyEnv || '')
  const apiKey = await resolveApiKey(ctx, keyEnv, c.apiKey)

  let baseUrl = String(c.baseUrl || '').replace(/\/+$/, '')
  let api = 'generic'
  if (c.provider) {
    const exact = await builtinImageModel(c.provider, c.model)
    if (exact && exact.baseUrl) {
      baseUrl = String(exact.baseUrl).replace(/\/+$/, '')
      api = String(exact.api || 'generic')
    } else {
      // Derive the base URL from any OpenAI-style model of that provider
      // (the specific model id may be served even when the local catalog
      // does not list it).
      for (const m of await builtinImageModels(c.provider)) {
        if ((m.api === 'openai-completions' || m.api === 'openai-responses') && m.baseUrl) {
          baseUrl = String(m.baseUrl).replace(/\/+$/, '')
          api = m.api
          break
        }
      }
      if (!baseUrl && section && section.baseURL) baseUrl = String(section.baseURL).replace(/\/+$/, '')
      if (section && section.api) api = String(section.api)
    }
  }
  return {
    provider: String(c.provider || ''),
    model: String(c.model || ''),
    baseUrl,
    api,
    apiKey,
    keyEnv,
    size: String(c.size || '1024x1024'),
    useModalities: c.useModalities !== false,
    outDir: String(c.outDir || 'oh-my-dsh-images'),
  }
}

/** Request-attempt order for a resolved route api type. */
export function attemptsFor(api) {
  if (api === 'openai-responses' || api === 'openai-codex-responses') return ['responses', 'chat', 'images']
  if (api === 'openai-completions') return ['chat', 'responses', 'images']
  return ['chat', 'responses', 'images']
}
