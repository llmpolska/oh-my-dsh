// Codex image generation through the ChatGPT images endpoint.
//
// In the official Codex client, image generation works through the
// `image_gen.imagegen` tool whose executor POSTs an OpenAI-style images
// request with `model: "gpt-image-2"` (codex-rs: ext/image-generation,
// codex-api images endpoint). The endpoint that passes Cloudflare for this
// client is `https://chatgpt.com/backend-api/codex/images/generations`
// (the `/api/codex/...` alias is bot-blocked for raw Node fetch). The image
// comes back as base64 PNG/JPG in `data[].b64_json`.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const AUTH_FILENAME = '.openai-codex-auth.json'
const IMAGES_URL = 'https://chatgpt.com/backend-api/codex/images/generations'

function codexAuthPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), AUTH_FILENAME)
}

/** Read the OAuth credential written by dsh-codex-connect's login. */
export function readCodexOAuth() {
  try {
    const data = JSON.parse(readFileSync(codexAuthPath(), 'utf8'))
    const cred = data && data.credential
    if (!cred || typeof cred.access !== 'string' || cred.access.length === 0) return null
    return {
      access: cred.access,
      accountId: typeof cred.accountId === 'string' ? cred.accountId : '',
    }
  } catch (e) {
    return null
  }
}

/** Fallback account id extraction from the access-token JWT payload. */
function accountIdFromToken(access) {
  try {
    const parts = access.split('.')
    if (parts.length !== 3) return ''
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const auth = payload && payload['https://api.openai.com/auth']
    const id = auth && auth['chatgpt_account_id']
    return typeof id === 'string' ? id : ''
  } catch (e) {
    return ''
  }
}

/**
 * Generate images through the Codex images endpoint (gpt-image-2).
 * @param prompt - the image prompt.
 * @param size - requested size, e.g. 1024x1024 or 'auto'.
 * @param signal - abort signal.
 * @returns { ok, message, b64: string[] }
 */
export async function generateCodexImage(prompt, signal) {
  const oauth = readCodexOAuth()
  if (!oauth) {
    return { ok: false, b64: [], message: 'Codex is not signed in. Sign in first: Settings → Plugins → Plugin configuration → Codex Connect → Sign in with ChatGPT (or run: dsh plugin --profile desktop exec dsh-codex-connect login).' }
  }
  const accountId = oauth.accountId || accountIdFromToken(oauth.access)
  if (!accountId) {
    return { ok: false, b64: [], message: 'Codex OAuth credential has no usable account id; sign in again (dsh-codex-connect login).' }
  }
  const body = {
    prompt,
    model: 'gpt-image-2',
    background: 'auto',
    quality: 'auto',
  }
  const timeout = AbortSignal.timeout(180000)
  let res
  try {
    res = await fetch(IMAGES_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + oauth.access,
        'chatgpt-account-id': accountId,
        originator: 'codex_cli_rs',
        'User-Agent': 'codex_cli_rs/0.54.0 (macOS 15.0; arm64) codex_cli_rs',
        'x-codex-image-turn-id': randomUUID(),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch (e) {
    if (timeout.aborted && !(signal && signal.aborted)) {
      return { ok: false, b64: [], message: 'Codex image generation timed out after 180s.' }
    }
    return { ok: false, b64: [], message: 'Codex image request failed: ' + String(e && e.message || e) }
  }
  const text = await res.text()
  if (!res.ok) {
    let detail = text.slice(0, 300)
    try {
      const parsed = JSON.parse(text)
      detail = (parsed.error && (parsed.error.message || JSON.stringify(parsed.error))) || detail
    } catch (e) {}
    return { ok: false, b64: [], message: 'Codex images HTTP ' + res.status + ': ' + detail }
  }
  let data
  try { data = JSON.parse(text) } catch (e) {
    return { ok: false, b64: [], message: 'Codex images returned an invalid response.' }
  }
  const entries = data && Array.isArray(data.data) ? data.data : []
  const b64 = entries.map((entry) => entry && typeof entry.b64_json === 'string' ? entry.b64_json : null).filter(Boolean)
  if (b64.length === 0) {
    return { ok: false, b64: [], message: 'Codex images answered without an image payload.' }
  }
  return { ok: true, b64, message: '' }
}
