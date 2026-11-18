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
 * Ventaja en el orden para lo que es estado actual (un documento, una nota de memoria) frente
 * a lo que es historia (un commit, una conversación), a igual parecido. Es la misma regla de
 * precedencia que se le da a quien lee los resultados.
 */
export const AUTHORITY = { doc: 1, memory: 1, git: 0, conv: 0 }

/**
 * Un commit que está en dos repos (uno es copia del otro) es el mismo commit: cuenta su hash,
 * no el repo. El resto, por su texto.
 * @param {{ kind: string, path: string, heading: string, text: string }} r
 */
export function dedupeKey (r) {
  if (r.kind === 'git') return `git@${r.path.slice(r.path.lastIndexOf('@') + 1)}`
  return `${r.heading}\n${r.text}`
}

/** Cuántos candidatos lee el reordenador. */
export const RERANK_POOL = 30

/**
 * @param {{ store: import('./store.js').Store, embedder: import('./embed.js').Embedder, reranker?: import('./rerank.js').Reranker | null, query: string, k?: number, pathPrefix?: string, minScore?: number }} opts
 */
export async function search ({ store, embedder, reranker = null, query, k = 8, pathPrefix, minScore }) {
  const all = store.vectors()
  if (!all.ids.length) return []
  const [qv] = await embedder.embed([query], 'query')
  const lists = [nearest(qv, all, POOL), store.lexical(ftsQuery(query), POOL)]
  /** @type {Map<number, number>} */
  const fused = new Map()
  for (const list of lists) list.forEach((id, rank) => fused.set(id, (fused.get(id) || 0) + 1 / (RRF_K + rank + 1)))
  const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)

  // El mismo texto puede vivir en dos sitios (una copia de dotrino-native dentro de cada app
  // nativa): se enseña una vez, en su primer sitio.
  const seen = new Set()
  let rows = store.chunksById(ranked)
    .filter(r => !pathPrefix || r.path.startsWith(pathPrefix))
    .filter(r => { const key = dedupeKey(r); if (seen.has(key)) return false; seen.add(key); return true })

  /** @type {Map<number, number>} */
  let score = fused
  if (reranker) {
    rows = rows.slice(0, Math.max(RERANK_POOL, k))
    const s = await reranker.score(query, rows.map(r => `${r.heading}\n${r.text}`))
    score = new Map(rows.map((r, i) => [r.id, s[i] + (AUTHORITY[r.kind] || 0)]))
    rows = rows.slice().sort((a, b) => /** @type {number} */ (score.get(b.id)) - /** @type {number} */ (score.get(a.id)))
    if (minScore !== undefined) rows = rows.filter(r => /** @type {number} */ (score.get(r.id)) >= minScore)
  }
  return rows.slice(0, k).map(r => ({ path: r.path, kind: r.kind, date: r.date, heading: r.heading, line: r.line, text: r.text, score: /** @type {number} */ (score.get(r.id)) }))
}
