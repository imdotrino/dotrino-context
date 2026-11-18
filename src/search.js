// Búsqueda híbrida: por significado (vectores) y por palabra (FTS5), juntadas por rango
// recíproco. Lo semántico encuentra «qué llave firma el acta» aunque el texto diga
// «maestra»; lo léxico no pierde un nombre exacto como `requireSealed`.

const POOL = 50
const RRF_K = 60

/**
 * Convierte texto libre en una consulta FTS5 segura: cada palabra entre comillas, unidas
 * con OR. Así ningún carácter del usuario se lee como operador.
 * @param {string} q
 */
export function ftsQuery (q) {
  const words = q.match(/[\p{L}\p{N}_]{2,}/gu) || []
  return [...new Set(words)].map(w => `"${w}"`).join(' OR ')
}

/**
 * @param {Float32Array} q
 * @param {{ ids: Int32Array, vecs: Float32Array, dims: number }} all
 * @param {number} limit
 */
export function nearest (q, all, limit) {
  const { ids, vecs, dims } = all
  /** @type {[number, number][]} */
  const scored = []
  for (let i = 0; i < ids.length; i++) {
    let s = 0
    const o = i * dims
    for (let j = 0; j < dims; j++) s += q[j] * vecs[o + j]
    scored.push([ids[i], s])
  }
  scored.sort((a, b) => b[1] - a[1])
  return scored.slice(0, limit).map(x => x[0])
}

/**
 * @param {{ store: import('./store.js').Store, embedder: import('./embed.js').Embedder, query: string, k?: number, pathPrefix?: string }} opts
 */
export async function search ({ store, embedder, query, k = 8, pathPrefix }) {
  const all = store.vectors()
  if (!all.ids.length) return []
  const [qv] = await embedder.embed([query], 'query')
  const lists = [nearest(qv, all, POOL), store.lexical(ftsQuery(query), POOL)]
  /** @type {Map<number, number>} */
  const score = new Map()
  for (const list of lists) list.forEach((id, rank) => score.set(id, (score.get(id) || 0) + 1 / (RRF_K + rank + 1)))
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  const rows = store.chunksById(ranked)
  // El mismo texto puede vivir en dos sitios (una copia de dotrino-native dentro de cada app
  // nativa): se enseña una vez, en su primer sitio.
  const seen = new Set()
  return rows
    .filter(r => !pathPrefix || r.path.startsWith(pathPrefix))
    .filter(r => { const key = `${r.heading}\n${r.text}`; if (seen.has(key)) return false; seen.add(key); return true })
    .slice(0, k)
    .map(r => ({ path: r.path, heading: r.heading, line: r.line, text: r.text, score: /** @type {number} */ (score.get(r.id)) }))
}
