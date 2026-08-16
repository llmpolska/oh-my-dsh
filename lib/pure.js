// Dependency-free pure logic for oh-my-dsh.
//
// These functions contain no harness imports and no I/O, so they are
// unit-testable with plain `node --test` (see tests/pure.test.mjs). The
// in-session dynamic plugin loads this file directly.

/**
 * Detect `rm` with BOTH recursive (`-r`/`-R`/`--recursive`) and force (`-f`/
 * `--force`) flags, allowing split flags like `rm -r -f` that a single-token
 * regex misses. Anchored to command position so prose like "echo rm -rf"
 * does not match.
 */
export function hasRecursiveForceRm(cmd) {
  if (typeof cmd !== 'string') return false
  // rm at command position: start of string, after a separator, or after a
  // known command runner (sudo, env, timeout, ...). "echo rm -rf" stays a
  // miss because echo is not a runner.
  const sep = cmd.match(/(^|[;&|]\s*|\b(sudo|command|env|timeout|nice|xargs|exec|busybox)\s+)rm(\s+)/i)
  if (!sep) return false
  const rest = cmd.slice(sep.index + sep[0].length)
  let flags = ''
  for (const token of rest.split(/\s+/)) {
    if (/^--?[a-zA-Z]/.test(token)) flags += token.replace(/^-+/, '')
    else break
  }
  flags = flags.toLowerCase()
  return flags.includes('r') && flags.includes('f')
}

/** Conservative high-impact command patterns (checked after the rm rule). */
export const HIGH_IMPACT_COMMAND = [
  /\bmkfs\.?[a-z]*\b/,
  /\bdd\s+if=/,
  /(^|[;&|]\s*)sudo\b/,
  /(^|[;&|]\s*)(shutdown|reboot|halt)\b/,
  /git\s+push\s+[^\n]*(-f\b|--force)/,
  /git\s+clean\s+(-[a-z]*f[a-z]*\b)/,
  /find\s+[^\n]*\s+-delete\b/,
  /find\s+[^\n]*-exec\s+[^\n]*\brm\b/,
  /\b(shutil\.rmtree|rmtree)\s*\(/,
  /\bos\.remove\s*\(/,
  /python[0-9.]*\s+-c\s+[^|;&\n]*(rmtree|os\.remove|shutil\.rmtree|rm\s+-rf)/,
  /curl\s+[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/,
  /wget\s+[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/,
  /\bchmod\s+[0-7]{3,4}\s+[^\n]*\.ssh\//,
  /\bchown\s/,
]

/**
 * Conservative high-impact file-path patterns (credentials, keys, secrets).
 * `.env` matches unless the suffix is an example/sample/template name.
 */
export const HIGH_IMPACT_PATH = [
  /(^|\/)\.env(\.(?!example|sample|template)[^/]*)?$/i,
  /(^|\/)(credentials?|secrets?)(\.(json|ya?ml|toml|ini|env|key|pem|txt))?($|\/)/i,
  /(^|\/)\.ssh\//,
  /id_(rsa|ed25519|ecdsa)\b/i,
  /\.pem$/,
  /\.key$/,
]

/**
 * Match a tool call against the high-impact patterns.
 * @param name - the tool name ('bash', 'write', 'edit', ...).
 * @param args - the parsed tool arguments.
 * @returns a human-readable match description, or null when the call is not high-impact.
 */
export function isHighImpact(name, args) {
  if (!args || typeof args !== 'object') return null
  if (name === 'bash' && typeof args.command === 'string') {
    if (hasRecursiveForceRm(args.command)) {
      return 'command pattern rm -r/-f matched (recursive force delete)'
    }
    for (const re of HIGH_IMPACT_COMMAND) {
      const m = String(args.command).match(re)
      if (m) return 'command pattern /' + re.source + '/ matched: "' + String(m[0]).trim().slice(0, 80) + '"'
    }
  }
  if ((name === 'write' || name === 'edit') && typeof args.file_path === 'string') {
    for (const re of HIGH_IMPACT_PATH) {
      if (re.test(String(args.file_path))) return 'file path pattern /' + re.source + '/ matched: "' + String(args.file_path).slice(0, 120) + '"'
    }
  }
  return null
}

/**
 * Resolve the effective tier for one step from a plain decision spec.
 * @param spec
 *   explicitTier:  per-agent explicit tier ('strong' | 'cheap'), e.g. from omd_worker.
 *   visionActive:  the session is locked onto the vision model for the current image turn.
 *   sessionMode:   per-session override ('strong' | 'cheap' | 'off'); 'off' opts
 *                  the session out of all routing.
 *   escalated:     whether failure auto-escalation is active.
 *   isChild:       whether the agent is a subagent child.
 *   subagentPolicy: 'inherit' | 'cheap' | 'strong'.
 *   mode:          'auto' | 'strong' | 'cheap' | 'off' (the global default).
 *   planActive:    whether plan mode is active for the agent.
 * @returns 'strong' | 'cheap' | 'vision' | null (null = no routing decision, e.g. mode off).
 */
export function resolveTierSpec(spec) {
  if (spec.explicitTier) return spec.explicitTier === 'strong' ? 'strong' : 'cheap'
  if (spec.sessionMode === 'off') return null
  if (spec.sessionMode === 'strong') return 'strong'
  if (spec.sessionMode === 'cheap') return 'cheap'
  if (spec.visionActive) return 'vision'
  if (spec.escalated) return 'strong'
  if (spec.isChild && spec.subagentPolicy === 'strong') return 'strong'
  if (spec.isChild && spec.subagentPolicy === 'cheap') return 'cheap'
  if (spec.mode === 'strong') return 'strong'
  if (spec.mode === 'cheap') return 'cheap'
  if (spec.mode === 'auto') return spec.planActive ? 'strong' : 'cheap'
  return null
}

// ---- image-response parsing (pure, unit-tested) ---------------------------

/**
 * Walk an arbitrary JSON response and collect image candidates:
 * base64 data URLs, https image URLs, and `b64_json` fields.
 */
export function collectImageCandidates(value, out) {
  if (!value) return
  if (typeof value === 'string') {
    // Data URLs anywhere in the text (bare or markdown-embedded).
    const dataRe = /data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/gi
    let m
    while ((m = dataRe.exec(value))) out.push({ kind: 'b64', data: m[1] })
    // Direct https image URLs (bare or markdown-embedded).
    const urlRe = /https?:\/\/[^\s"'<>)\]]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>)\]]*)?/gi
    let u
    while ((u = urlRe.exec(value))) out.push({ kind: 'url', url: u[0] })
    return
  }
  if (Array.isArray(value)) { for (const item of value) collectImageCandidates(item, out); return }
  if (typeof value !== 'object') return
  if (typeof value.b64_json === 'string' && value.b64_json.length > 64) out.push({ kind: 'b64', data: value.b64_json })
  if (value.type === 'image_url' && value.image_url) {
    const u = typeof value.image_url === 'string' ? value.image_url : value.image_url.url
    if (typeof u === 'string') out.push({ kind: u.startsWith('data:') ? 'data' : 'url', data: u, url: u })
  }
  for (const key of Object.keys(value)) {
    if (key === 'image_url' || key === 'b64_json') continue
    collectImageCandidates(value[key], out)
  }
}

/**
 * Walk an arbitrary JSON response and collect `<svg>…</svg>` blocks found in
 * any text (markdown fences stripped). A chat model that cannot attach image
 * parts often answers with SVG markup instead — treat it as an image.
 */
export function collectSvgCandidates(value, out) {
  const texts = []
  const walk = (v) => {
    if (!v) return
    if (typeof v === 'string') { texts.push(v); return }
    if (Array.isArray(v)) { for (const item of v) walk(item); return }
    if (typeof v === 'object') {
      for (const key of Object.keys(v)) {
        if (key === 'image_url' || key === 'b64_json') continue
        walk(v[key])
      }
    }
  }
  walk(value)
  for (const raw of texts) {
    const src = String(raw).replace(/```(?:svg|html)?/gi, '')
    const re = /<svg[\s\S]*?<\/svg>/gi
    let m
    while ((m = re.exec(src))) out.push({ kind: 'svg', data: m[0] })
  }
}
