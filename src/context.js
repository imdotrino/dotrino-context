// Una carpeta abierta: su base, el modelo y el índice al día. El índice se refresca solo si
// pasó un rato desde la última pasada, y nunca dos pasadas a la vez.
import path from 'node:path'
import os from 'node:os'
import { Store } from './store.js'
import { createEmbedder } from './embed.js'
import { createReranker } from './rerank.js'
import { indexFolder } from './indexer.js'
import { search } from './search.js'

export const REFRESH_MS = 30_000

/**
 * Abre la carpeta y su cadena de bases: la propia y las de los padres (ver `baseChain`).
 * @param {{ root: string, chain?: string[], embedder?: import('./embed.js').Embedder, reranker?: import('./rerank.js').Reranker | null, stores?: Store[], home?: string, log?: (m: string) => void, refreshMs?: number }} opts
 */
export function openContext ({ root, chain, embedder = createEmbedder(), reranker = createReranker(), stores, home, log = () => {}, refreshMs = REFRESH_MS }) {
  const dirs = (chain || [root]).map(d => path.resolve(d))
  for (const dir of dirs) {
    // Indexar la carpeta personal o la raíz recorrería todo el disco. No se intenta: se dice.
    if (dir === path.parse(dir).root || dir === path.resolve(os.homedir())) {
      throw Object.assign(new Error(`refusing to index ${dir}: pick a project folder (--root)`), { code: 'root-too-broad' })
    }
  }
  const dbs = stores || dirs.map(d => Store.open(d))
  /** @type {Promise<any> | null} */
  let running = null
  let lastRun = 0

  // La base propia primero: es la que más importa tener al día.
  const reindex = () => {
    if (!running) {
      running = (async () => {
        let own = null
        for (let i = 0; i < dirs.length; i++) {
          const r = await indexFolder({ root: dirs[i], store: dbs[i], embedder, home, log })
          if (i === 0) own = r
        }
        return own
      })().finally(() => { running = null; lastRun = Date.now() })
    }
    return running
  }

  return {
    root: dirs[0],
    chain: dirs,
    store: dbs[0],
    reindex,
    /** @param {string} query @param {{ k?: number, pathPrefix?: string, minScore?: number, maxGap?: number }} [opts] */
    async search (query, opts = {}) {
      // Con la base vacía no hay nada que buscar: se espera a la primera pasada. Con datos, se
      // busca en lo que hay y la pasada sigue por detrás: una primera indexación larga (los
      // commits y las conversaciones) no puede dejar la búsqueda colgada minutos.
      const empty = dbs.every(d => d.stats().chunks === 0)
      if (running) { if (empty) await running } else if (Date.now() - lastRun > refreshMs) {
        const p = reindex()
        if (empty) await p
        else p.catch(e => log(`index: failed: ${e?.stack || e}`))
      }
      return search({ stores: dbs.map((store, level) => ({ store, level })), embedder, reranker, query, log, ...opts })
    },
    stats: () => ({ root: dirs[0], chain: dirs, ...dbs[0].stats() }),
    close: () => { for (const d of dbs) d.close() }
  }
}
