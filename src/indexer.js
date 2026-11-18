// Una pasada: recorre las fuentes, salta las que no cambiaron (por su sello) y, dentro de las
// que sí, solo recalcula los documentos cuya versión cambió. Lo que ya no existe se borra.
import fs from 'node:fs'
import { containers as listContainers, MAX_FILE_BYTES } from './sources.js'

/**
 * @param {{ root: string, store: import('./store.js').Store, embedder: import('./embed.js').Embedder, home?: string, now?: () => number, log?: (msg: string) => void }} opts
 */
export async function indexFolder ({ root, store, embedder, home, now, log = () => {} }) {
  if (store.ensureModel(embedder.model)) log(`index: fresh index for model ${embedder.model}`)
  const known = store.containers()
  const seen = new Set()
  /** @type {string[]} */
  const skipped = []
  const r = { added: 0, updated: 0, removed: 0, chunks: 0 }

  for (const c of listContainers(root, { home, now })) {
    let stamp
    try {
      if ((c.kind === 'doc' || c.kind === 'memory') && fs.statSync(c.key).size > MAX_FILE_BYTES) { skipped.push(c.key); continue }
      stamp = c.stamp()
    } catch (e) {
      if (/** @type {any} */ (e).code === 'ENOENT') continue
      throw e
    }
    seen.add(c.key)
    // Sin sello (una conversación en curso): se deja lo que ya había, sin tocarlo.
    if (stamp === null || known.get(c.key)?.stamp === stamp) continue

    const prev = store.docsOf(c.key)
    const present = new Set()
    for await (const doc of c.docs()) {
      present.add(doc.key)
      if (prev.get(doc.key) === doc.version) continue
      const vecs = doc.chunks.length ? await embedder.embed(doc.chunks.map(ch => `${ch.heading}\n${ch.text}`), 'passage') : []
      store.putDoc(c.key, c.kind, doc, vecs)
      r.chunks += doc.chunks.length
      if (prev.has(doc.key)) r.updated++; else r.added++
      if ((r.added + r.updated) % 100 === 0) log(`index: ${r.added + r.updated} documents embedded`)
    }
    for (const k of prev.keys()) if (!present.has(k)) { store.removeDoc(k); r.removed++ }
    store.setContainer(c.key, c.kind, stamp)
  }
  for (const k of known.keys()) {
    if (!seen.has(k)) { r.removed += store.docsOf(k).size; store.removeContainer(k) }
  }
  if (r.removed) store.compact()
  store.setMeta('skipped', JSON.stringify(skipped))
  store.setMeta('indexedAt', new Date().toISOString())
  return { ...r, skipped: skipped.length }
}
