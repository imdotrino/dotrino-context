// Recorre la carpeta (y la memoria de Claude de esa carpeta), y solo vuelve a calcular los
// vectores de lo que cambió: primero mira fecha y tamaño, y si cambiaron, el hash.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { chunkMarkdown } from './chunk.js'
import { claudeMemoryDir, CONTEXT_DIRNAME } from './paths.js'

/** Carpetas que nunca son documentación: dependencias, compilados, cachés. */
export const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', 'vendor', 'out', 'Pods', 'DerivedData', CONTEXT_DIRNAME])
export const MAX_FILE_BYTES = 512 * 1024

/**
 * Los .md bajo `dir`, sin carpetas ocultas ni las de SKIP_DIRS, y sin seguir enlaces.
 * @param {string} dir
 * @returns {string[]}
 */
export function walkMarkdown (dir) {
  /** @type {string[]} */
  const out = []
  /** @param {string} d */
  const visit = d => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch (e) {
      if (/** @type {any} */ (e).code === 'ENOENT') return
      throw e
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) visit(p) } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(p)
    }
  }
  visit(dir)
  return out
}

/**
 * Las fuentes de una carpeta: sus .md y la memoria de Claude Code que le corresponde.
 * @param {string} root
 * @param {{ home?: string }} [opts]
 */
export function sourceFiles (root, opts = {}) {
  const files = walkMarkdown(path.resolve(root))
  const mem = claudeMemoryDir(root, opts)
  if (fs.existsSync(mem)) {
    for (const e of fs.readdirSync(mem, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.md')) files.push(path.join(mem, e.name))
    }
  }
  return files
}

/**
 * @param {{ root: string, store: import('./store.js').Store, embedder: import('./embed.js').Embedder, home?: string, log?: (msg: string) => void }} opts
 */
export async function indexFolder ({ root, store, embedder, home, log = () => {} }) {
  if (store.ensureModel(embedder.model)) log(`index: fresh index for model ${embedder.model}`)
  const known = store.files()
  const seen = new Set()
  let added = 0; let updated = 0; let removed = 0; let skipped = 0; let chunks = 0

  for (const file of sourceFiles(root, { home })) {
    let st
    try { st = fs.statSync(file) } catch (e) {
      if (/** @type {any} */ (e).code === 'ENOENT') continue
      throw e
    }
    if (st.size > MAX_FILE_BYTES) { skipped++; continue }
    seen.add(file)
    const prev = known.get(file)
    if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) continue
    const src = fs.readFileSync(file, 'utf8')
    const hash = crypto.createHash('sha256').update(src).digest('hex')
    if (prev && prev.hash === hash) { store.touchFile(file, st.mtimeMs, st.size); continue }
    const parts = chunkMarkdown(src, { title: path.basename(file, '.md') })
    const vecs = parts.length ? await embedder.embed(parts.map(c => `${c.heading}\n${c.text}`), 'passage') : []
    store.replaceFile(file, { mtime: st.mtimeMs, size: st.size, hash }, parts, vecs)
    chunks += parts.length
    if (prev) updated++; else added++
    if ((added + updated) % 25 === 0) log(`index: ${added + updated} files embedded`)
  }
  for (const p of known.keys()) {
    if (!seen.has(p)) { store.removeFile(p); removed++ }
  }
  store.setMeta('indexedAt', new Date().toISOString())
  return { added, updated, removed, skipped, chunks }
}
