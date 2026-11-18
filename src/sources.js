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
import { claudeMemoryDir, CONTEXT_DIRNAME } from './paths.js'
import { loadIgnore } from './ignore.js'
import { redact } from './redact.js'

/** Carpetas que nunca son documentación: dependencias, compilados, cachés. */
export const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', 'vendor', 'out', 'Pods', 'DerivedData', CONTEXT_DIRNAME])
export const MAX_FILE_BYTES = 512 * 1024
/** Una conversación entra cuando lleva este rato sin cambiar: la que está en curso ya está en contexto. */
export const QUIET_MS = 10 * 60 * 1000

/**
 * @typedef {import('./chunk.js').Chunk} Chunk
 * @typedef {{ key: string, path: string, version: string, date: string, chunks: Chunk[] }} Doc
 * @typedef {{ key: string, kind: 'doc' | 'memory' | 'git' | 'conv', stamp: () => string | null, docs: () => AsyncIterable<Doc> | Iterable<Doc> }} Container
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
      if (/** @type {any} */ (e).code === 'ENOENT' || /** @type {any} */ (e).code === 'EACCES') return
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
        if (/unknown revision|ambiguous argument 'HEAD'|does not have any commits/.test(String(/** @type {any} */ (e).stderr))) return 'empty'
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
    .replace(/<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g, '')
    .trim()
}

const USER_MAX = 2000
const ASSISTANT_MAX = 4000

/**
 * Una conversación de Claude Code: un documento por turno (lo que dijo la persona y lo que
 * se le respondió en texto). Fuera las herramientas, sus salidas y el razonamiento.
 * @param {string} file
 * @param {{ now?: () => number }} [opts]
 * @returns {Container}
 */
function conversation (file, { now = Date.now } = {}) {
  return {
    key: file,
    kind: 'conv',
    stamp () {
      const st = fs.statSync(file)
      if (now() - st.mtimeMs < QUIET_MS) return null
      return `${st.mtimeMs}:${st.size}`
    },
    async * docs () {
      const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity })
      /** @type {{ line: number, date: string, user: string, reply: string[] } | null} */
      let turn = null
      let n = 0
      const close = () => {
        if (!turn) return null
        const reply = turn.reply.join('\n\n').slice(0, ASSISTANT_MAX)
        const text = redact(`Usuario: ${turn.user.slice(0, USER_MAX)}${reply ? `\n\nClaude: ${reply}` : ''}`)
        const doc = { key: `conv:${file}:${turn.line}`, path: file, version: sha(text), date: turn.date, chunks: splitLong(text).map(t => ({ heading: `conversación ${turn?.date}`, line: /** @type {any} */ (turn).line, text: t })) }
        turn = null
        return doc
      }
      for await (const raw of rl) {
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
          const done = close()
          if (done) yield done
          turn = { line: n, date: String(o.timestamp || '').slice(0, 10), user: text, reply: [] }
        } else if (o.type === 'assistant' && turn && Array.isArray(content)) {
          for (const p of content) if (p.type === 'text' && p.text) turn.reply.push(p.text)
        }
      }
      const last = close()
      if (last) yield last
    }
  }
}

/**
 * Todas las fuentes de una carpeta.
 * @param {string} root
 * @param {{ home?: string, now?: () => number }} [opts]
 */
export function containers (root, opts = {}) {
  const dir = path.resolve(root)
  const { md, repos } = walk(dir)
  /** @type {Container[]} */
  const out = md.map(f => markdownFile(f, 'doc'))
  const mem = claudeMemoryDir(dir, opts)
  const projectDir = path.dirname(mem)
  if (fs.existsSync(mem)) {
    for (const e of fs.readdirSync(mem, { withFileTypes: true })) if (e.isFile() && e.name.endsWith('.md')) out.push(markdownFile(path.join(mem, e.name), 'memory'))
  }
  for (const r of repos) out.push(gitRepo(r))
  if (fs.existsSync(projectDir)) {
    for (const e of fs.readdirSync(projectDir, { withFileTypes: true })) if (e.isFile() && e.name.endsWith('.jsonl')) out.push(conversation(path.join(projectDir, e.name), opts))
  }
  return out
}
