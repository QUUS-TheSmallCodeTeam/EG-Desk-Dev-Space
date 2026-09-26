import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export const MAX_TEXT = 20000

// No raw tool arguments/results, diffs, environment or reasoning enter public state.
// Text that is intentionally public still gets common credential patterns redacted.
export function publicText(value, limit = MAX_TEXT) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b(Bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/((?:["']?[\w-]*(?:password|passwd|secret|api[_-]?key|token|cookie|authorization)[\w-]*["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|key|code|secret|access_token|api_key)=)[^&#\s]+/gi, '$1[REDACTED]')
    .slice(0, limit)
}

export function publicError(error, code = 'CHAT_ERROR', origin = 'bridge') {
  return { code: String(code), origin, message: publicText(error?.message || error || 'Codex request failed', 2000) }
}

export function chatError(code, message, httpStatus = 400) {
  return Object.assign(new Error(message), { code, httpStatus })
}

const artifactExtensions = new Set(['.pdf', '.docx', '.xlsx', '.xls', '.pptx', '.csv', '.tsv', '.txt', '.md', '.png', '.jpg', '.jpeg', '.webp', '.gif'])
const scriptExtensions = /\.(?:[cm]?js|jsx|tsx?|sh|bash|zsh|fish|py|rb|pl|php|ps1|bat|cmd|exe|app|html?|svg|wasm)$/i
const sensitivePath = /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|\.ssh|\.aws|\.gnupg|auth\.json|credentials(?:\.json)?|id_rsa|id_ed25519)(?:$|[/\\])|\.(?:pem|key|p12|pfx)$/i

export async function verifyLocalFile(candidate, { artifact = false } = {}) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || /[\u0000-\u001f]/.test(candidate)) return null
  if (candidate.startsWith('//') || sensitivePath.test(candidate)) return null
  if (artifact && (!artifactExtensions.has(path.extname(candidate).toLowerCase()) || scriptExtensions.test(candidate))) return null
  try {
    const canonical = await realpath(candidate)
    if (sensitivePath.test(canonical)) return null
    if (artifact && (!artifactExtensions.has(path.extname(canonical).toLowerCase()) || scriptExtensions.test(canonical))) return null
    const info = await stat(canonical)
    if (!info.isFile() || (artifact && (info.mode & 0o111))) return null
    return canonical
  } catch { return null }
}

// Only explicit Markdown file links. Ordinary text, URLs, labels and commands
// are never evidence of a file write, nor are they converted into documents.
export function explicitFileLinks(text) {
  const links = []
  for (const match of String(text || '').matchAll(/\[([^\]\n]{1,160})\]\((?:<([^>\n]+)>|(\/[^)\n]+))\)/g)) {
    const raw = (match[2] || match[3] || '').replace(/:\d+(?::\d+)?$/, '')
    if (path.isAbsolute(raw) && !raw.startsWith('//')) links.push({ label: publicText(match[1], 160), path: raw })
    if (links.length === 20) break
  }
  return links
}
