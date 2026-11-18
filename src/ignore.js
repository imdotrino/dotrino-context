// `.dotrino-contextignore`: rutas que no entran en la base, con la sintaxis corta de
// .gitignore. Una línea por patrón; `#` comenta. Sin `/` vale en cualquier nivel; con `/`
// al principio, desde la raíz; con `/` al final, solo carpetas (y todo lo que tienen dentro).
import fs from 'node:fs'
import path from 'node:path'

export const IGNORE_FILE = '.dotrino-contextignore'

/** @param {string} glob */
function toRegex (glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++ } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return re
}

/**
 * @param {string} text
 * @returns {(rel: string, isDir: boolean) => boolean}
 */
export function parseIgnore (text) {
  const rules = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => {
    const dirOnly = l.endsWith('/')
    let p = dirOnly ? l.slice(0, -1) : l
    const anchored = p.startsWith('/') || p.includes('/')
    p = p.replace(/^\//, '')
    const body = toRegex(p)
    return { dirOnly, re: new RegExp(anchored ? `^${body}$` : `(^|/)${body}$`) }
  })
  return (rel, isDir) => rules.some(r => (!r.dirOnly || isDir) && r.re.test(rel))
}

/** @param {string} root */
export function loadIgnore (root) {
  const f = path.join(root, IGNORE_FILE)
  return parseIgnore(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
}
