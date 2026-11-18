// Las fuentes de una carpeta. Cada fuente es un «contenedor» con un sello barato de calcular
// (fecha y tamaño, o el HEAD de un repo): si el sello no cambió, nada de lo que tiene dentro
// se vuelve a mirar. Dentro hay «documentos», cada uno con su versión (un hash): solo se
// recalculan los vectores de los documentos cuya versión cambió.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import readline from 'node:readline'
import { execFileSync } from 'node:child_process'
import { chunkMarkdown, splitLong } from './chunk.js'
import { CONTEXT_DIRNAME, projectSlug } from './paths.js'
import os from 'node:os'
import { loadIgnore } from './ignore.js'
import { redact } from './redact.js'

/** Carpetas que nunca son documentación: dependencias, compilados, cachés. */
export const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', 'vendor', 'out', 'Pods', 'DerivedData', CONTEXT_DIRNAME])
export const MAX_FILE_BYTES = 512 * 1024

/**
 * @typedef {import('./chunk.js').Chunk} Chunk
 * @typedef {{ key: string, path: string, version: string, date: string, chunks: Chunk[] }} Doc
 * @typedef {{ key: string, kind: 'doc' | 'memory' | 'git', stamp: () => string, docs: () => AsyncIterable<Doc> | Iterable<Doc> }} Container
 */

const sha = (/** @type {string} */ s) => crypto.createHash('sha256').update(s).digest('hex')

/**
 * Recorre la carpeta: los .md y los repos de git que encuentre, sin carpetas ocultas, sin
 * SKIP_DIRS, sin lo que diga `.dotrino-contextignore`, y sin seguir enlaces.
 * @param {string} root
 */
export function walk (root) {
  const ignored = loadIgnore(root)
  /** @type {string[]} */ const md = []
  /** @type {string[]} */ const repos = []
  /** @type {string[]} */ const tooBig = []
  /** @param {string} d */
  const visit = d => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT' || /** @type {NodeJS.ErrnoException} */ (e).code === 'EACCES') return
      throw e
    }
    if (entries.some(e => e.name === '.git')) repos.push(d)
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = path.join(d, e.name)
      const rel = path.relative(root, p).split(path.sep).join('/')
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !ignored(rel, true)) visit(p)
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md') && !ignored(rel, false)) {
        md.push(p)
      }
    }
  }
  visit(root)
  return { md, repos, tooBig }
}

/** @param {string} file @param {'doc' | 'memory'} kind @returns {Container} */
function markdownFile (file, kind) {
  return {
    key: file,
    kind,
    stamp () {
      const st = fs.statSync(file)
      return `${st.mtimeMs}:${st.size}`
    },
    * docs () {
      const src = fs.readFileSync(file, 'utf8')
      const date = fs.statSync(file).mtime.toISOString().slice(0, 10)
      yield { key: file, path: file, version: sha(src), date, chunks: chunkMarkdown(src, { title: path.basename(file, '.md') }) }
    }
  }
}

/**
 * Los mensajes de commit de un repo: uno por documento, así un commit nuevo no obliga a
 * recalcular los demás. Un rebase que quita commits los quita también de la base.
 * @param {string} repo
 * @returns {Container}
 */
function gitRepo (repo) {
  return {
    key: `git:${repo}`,
    kind: 'git',
    stamp () {
      try {
        return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      } catch (e) {
        // Un repo recién creado no tiene HEAD: no es un error, es un repo vacío.
        if (/unknown revision|ambiguous argument 'HEAD'|does not have any commits/.test(String(/** @type {{ stderr?: string | Buffer }} */ (e).stderr))) return 'empty'
        throw e
      }
    },
    * docs () {
      const out = execFileSync('git', ['-C', repo, 'log', '--format=%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1e'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
      const name = path.basename(repo)
      for (const rec of out.split('\x1e')) {
        const [hash, author, date, subject, body] = rec.replace(/^\n/, '').split('\x1f')
        if (!hash) continue
        const text = redact([subject, (body || '').trim()].filter(Boolean).join('\n\n'))
        yield {
          key: `git:${repo}:${hash}`,
          path: `${repo}@${hash.slice(0, 10)}`,
          version: hash,
          date: (date || '').slice(0, 10),
          chunks: splitLong(text).map(t => ({ heading: `${name} · ${(date || '').slice(0, 10)} · ${author}`, line: 0, text: t }))
        }
      }
    }
  }
}

/**
 * Quita de un mensaje lo que no escribió la persona: avisos del sistema, salidas de
 * órdenes locales y etiquetas de comandos.
 * @param {string} s
 */
export function cleanUserText (s) {
  return s
    .replace(/<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|command-name|command-message|command-args|task-notification)>[\s\S]*?<\/\1>/g, '')
    // Avisos que llegan como mensaje del usuario pero los escribe Claude Code: un hook de
    // parada o el aviso de un proceso en segundo plano.
    .replace(/^(Stop hook feedback:|\[SYSTEM NOTIFICATION)[\s\S]*$/m, '')
    .trim()
}

/**
 * @typedef {{ line: number, date: string, user: string, reply: string[] }} Turn
 */

/**
 * Los turnos de una transcripción de Claude Code: lo que dijo la persona y el texto de lo que
 * se le respondió. Fuera herramientas, sus salidas, el razonamiento y los avisos automáticos.
 * Lo usa el hook, para leer el turno anterior de la conversación en curso. Las conversaciones
 * NO se indexan (decisión del dueño, 2026-11-18): eran la fuente principal de ruido y lo que
 * valía de ellas ya vive en una nota de memoria o en un `.md`.
 * @param {AsyncIterable<string> | Iterable<string>} lines
 * @param {number} [firstLine]  número de la primera línea, para que `line` apunte al archivo
 * @returns {AsyncGenerator<Turn>}
 */
export async function * readTurns (lines, firstLine = 1) {
  /** @type {Turn | null} */
  let turn = null
  let n = firstLine - 1
  for await (const raw of lines) {
    n++
    // Filtro barato antes de parsear: la mayoría de las líneas son otra cosa.
    if (!raw.includes('"type":"user"') && !raw.includes('"type":"assistant"')) continue
    let o
    try { o = JSON.parse(raw) } catch (_) { continue }
    if (o.isSidechain || o.isMeta) continue
    const content = o.message?.content
    if (o.type === 'user') {
      const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text) : []
      const text = cleanUserText(parts.join('\n'))
      if (!text) continue
      if (turn) yield turn
      turn = { line: n, date: String(o.timestamp || '').slice(0, 10), user: text, reply: [] }
    } else if (o.type === 'assistant' && turn && Array.isArray(content)) {
      for (const p of content) if (p.type === 'text' && p.text) turn.reply.push(p.text)
    }
  }
  if (turn) yield turn
}

/**
 * Las carpetas de Claude Code (`~/.claude/projects/<slug>`) de esta raíz y de sus
 * subcarpetas. El slug es ambiguo (`/a/b-c` y `/a/b/c` dan lo mismo), así que una carpeta que
 * no es la de la raíz entra solo si alguna de sus conversaciones dice que se abrió dentro.
 * @param {string} root
 * @param {{ home?: string }} [opts]
 * @returns {string[]}
 */
export function projectDirs (root, { home = os.homedir() } = {}) {
  const base = path.join(home, '.claude', 'projects')
  if (!fs.existsSync(base)) return []
  const slug = projectSlug(root)
  const out = []
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const dir = path.join(base, e.name)
    if (e.name === slug) out.push(dir)
    else if (e.name.startsWith(`${slug}-`) && openedUnder(dir, root)) out.push(dir)
  }
  return out
}

/**
 * ¿Alguna conversación de esta carpeta de Claude se abrió dentro de `root`? Se lee el `cwd`
 * de las primeras líneas de cada `.jsonl`.
 * @param {string} dir @param {string} root
 */
function openedUnder (dir, root) {
  const prefix = path.resolve(root) + path.sep
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
    const fd = fs.openSync(path.join(dir, e.name), 'r')
    try {
      const buf = Buffer.alloc(64 * 1024)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      const m = buf.toString('utf8', 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/)
      if (m) return (JSON.parse(`"${m[1]}"`) + path.sep).startsWith(prefix)
    } finally { fs.closeSync(fd) }
  }
  return false
}

/**
 * Todas las fuentes de una carpeta: sus `.md` y repos, y la memoria de Claude Code de ella y
 * de cualquiera de sus subcarpetas.
 * @param {string} root
 * @param {{ home?: string, now?: () => number }} [opts]
 */
export function containers (root, opts = {}) {
  const dir = path.resolve(root)
  const { md, repos } = walk(dir)
  /** @type {Container[]} */
  const out = md.map(f => markdownFile(f, 'doc'))
  for (const r of repos) out.push(gitRepo(r))
  for (const pd of projectDirs(dir, opts)) {
    const mem = path.join(pd, 'memory')
    if (fs.existsSync(mem)) {
      // MEMORY.md es el índice: una línea por nota, que ya están indexadas. Solo repetiría.
      for (const e of fs.readdirSync(mem, { withFileTypes: true })) if (e.isFile() && e.name.endsWith('.md') && e.name !== 'MEMORY.md') out.push(markdownFile(path.join(mem, e.name), 'memory'))
    }
  }
  return out
}
