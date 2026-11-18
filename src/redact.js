// Tapa lo que parezca un secreto antes de que un texto entre en la base. Es una red, no una
// garantía: atrapa los formatos conocidos y las asignaciones del tipo `token=...`.

const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
]
const ASSIGN = /\b(password|passwd|passphrase|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret)(\s*[:=]\s*)(["']?)[^\s"']{6,}\3/gi

/** @param {string} text */
export function redact (text) {
  let out = text
  for (const re of PATTERNS) out = out.replace(re, '[REDACTED]')
  return out.replace(ASSIGN, (_m, k, sep) => `${k}${sep}[REDACTED]`)
}
