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
export const AUTHORITY = { doc: 1, memory: 1.5, git: 0, conv: 0 }

/**
 * Cuántos trozos de una misma fuente pueden salir juntos. Cuatro turnos de la misma
 * conversación cuentan lo mismo y tapan a la fuente vigente; dos secciones de un documento
 * todavía pueden aportar cosas distintas. Un commit es ya una fuente por sí mismo.
 */
export const PER_SOURCE = { conv: 1, doc: 2, memory: 2, git: 1 }

/**
 * Un commit que está en dos repos (uno es copia del otro) es el mismo commit: cuenta su hash,
 * no el repo. El resto, por su texto.
 * @param {{ kind: string, path: string, heading: string, text: string }} r
 */
export function dedupeKey (r) {
  if (r.kind === 'git') return `git@${r.path.slice(r.path.lastIndexOf('@') + 1)}`
  return `${r.heading}\n${r.text}`
}

/**
 * Ventaja para lo que viene de la base propia de la carpeta frente a lo que viene de la base
 * de un padre (el subcontexto): sale primero, a igual parecido, sin esconder lo de arriba.
 */
export const OWN_BONUS = 0.5

/** Cuántos candidatos aporta cada base al reordenador. */
export const RERANK_POOL = 30

/**
 * Busca en una cadena de bases: la propia (nivel 0) y las de los padres (subcontexto). Cada
 * base aporta sus mejores candidatos (vectores + palabra), se quitan los repetidos quedándose
 * con el de la base más cercana, y el reordenador los ordena todos juntos.
 * @param {{ stores: { store: import('./store.js').Store, level: number }[], embedder: import('./embed.js').Embedder, reranker?: import('./rerank.js').Reranker | null, query: string, k?: number, pathPrefix?: string, minScore?: number, maxGap?: number, log?: (m: string) => void }} opts
 */
export async function search ({ stores, embedder, reranker = null, query, k = 8, pathPrefix, minScore, maxGap, log = () => {} }) {
  const live = stores.filter(({ store, level }) => {
    if (!store.vectors().ids.length) return false
    // Vectores de otro modelo no se comparan con los de este: esa base espera su reindexación.
    if (store.getMeta('model') !== embedder.model) { log(`search: skipping base at level ${level}: built with ${store.getMeta('model')}, not ${embedder.model}`); return false }
    return true
  })
  if (!live.length) return []
  const [qv] = await embedder.embed([query], 'query')

  /** @type {(import('./store.js').ChunkRow & { level: number, fused: number })[]} */
  let rows = []
  for (const { store, level } of live) {
    const lists = [nearest(qv, store.vectors(), POOL), store.lexical(ftsQuery(query), POOL)]
    /** @type {Map<number, number>} */
    const fused = new Map()
    for (const list of lists) list.forEach((id, rank) => fused.set(id, (fused.get(id) || 0) + 1 / (RRF_K + rank + 1)))
    const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
    const got = store.chunksById(ranked)
      .filter(r => !pathPrefix || r.path.startsWith(pathPrefix))
      .slice(0, Math.max(RERANK_POOL, k))
      .map(r => ({ ...r, level, fused: /** @type {number} */ (fused.get(r.id)) }))
    rows.push(...got)
  }

  // El mismo texto puede vivir en dos sitios (una copia de dotrino-native dentro de cada app
  // nativa, o la base propia y la del padre): se queda el de la base más cercana.
  rows.sort((a, b) => a.level - b.level || b.fused - a.fused)
  const seen = new Set()
  rows = rows.filter(r => { const key = dedupeKey(r); if (seen.has(key)) return false; seen.add(key); return true })

  /** @type {(r: typeof rows[number]) => number} */
  let scoreOf = r => r.fused + (r.level === 0 ? 1 : 0)
  if (reranker) {
    const s = await reranker.score(query, rows.map(r => `${r.heading}\n${r.text}`))
    const byRow = new Map(rows.map((r, i) => [r, s[i] + (AUTHORITY[/** @type {keyof typeof AUTHORITY} */ (r.kind)] || 0) + (r.level === 0 ? OWN_BONUS : 0)]))
    scoreOf = r => /** @type {number} */ (byRow.get(r))
  }
  rows.sort((a, b) => scoreOf(b) - scoreOf(a))
  /** @type {Map<string, number>} */
  const perSource = new Map()
  rows = rows.filter(r => {
    const n = (perSource.get(r.path) || 0) + 1
    perSource.set(r.path, n)
    return n <= (PER_SOURCE[/** @type {keyof typeof PER_SOURCE} */ (r.kind)] || 1)
  })
  if (reranker && minScore !== undefined) rows = rows.filter(r => scoreOf(r) >= minScore)
  // Corte relativo: lo que queda muy por debajo del mejor apenas aporta y ensucia el contexto.
  if (reranker && maxGap !== undefined && rows.length) {
    const top = scoreOf(rows[0])
    rows = rows.filter(r => scoreOf(r) >= top - maxGap)
  }
  return rows.slice(0, k).map(r => ({ path: r.path, kind: r.kind, date: r.date, heading: r.heading, line: r.line, text: r.text, level: r.level, score: scoreOf(r) }))
}
