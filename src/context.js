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
/** Cuánto espera una búsqueda a que termine el refresco antes de buscar en lo que hay. */
export const FRESH_WAIT_MS = 3_000

/**
 * Abre la carpeta y su cadena de bases: la propia y las de los padres (ver `baseChain`).
 * @param {{ root: string, chain?: string[], embedder?: import('./embed.js').Embedder, reranker?: import('./rerank.js').Reranker | null, stores?: Store[], home?: string, log?: (m: string) => void, refreshMs?: number, rebuild?: boolean }} opts
 */
export function openContext ({ root, chain, embedder = createEmbedder(), reranker = createReranker(), stores, home, log = () => {}, refreshMs = REFRESH_MS, rebuild = false }) {
  const dirs = (chain || [root]).map(d => path.resolve(d))
  for (const dir of dirs) {
    // Indexar la carpeta personal o la raíz recorrería todo el disco. No se intenta: se dice.
    if (dir === path.parse(dir).root || dir === path.resolve(os.homedir())) {
      throw Object.assign(new Error(`refusing to index ${dir}: pick a project folder (--root)`), { code: 'root-too-broad' })
    }
  }
  const dbs = stores || dirs.map(d => Store.open(d))
  /** @type {Promise<Awaited<ReturnType<typeof indexFolder>>> | null} */
  let running = null
  let lastRun = 0

  // La base propia primero: es la que más importa tener al día.
  const reindex = () => {
    if (!running) {
      running = (async () => {
        const own = await indexFolder({ root: dirs[0], store: dbs[0], embedder, home, rebuild, log })
        for (let i = 1; i < dirs.length; i++) await indexFolder({ root: dirs[i], store: dbs[i], embedder, home, log })
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
      /** @type {Promise<unknown> | null} */
      let pass = running
      if (!pass && Date.now() - lastRun > refreshMs) pass = reindex()
      if (pass) {
        if (empty) await pass
        else {
          // Lo recién escrito tiene que poder salir: se espera a la pasada, con tope. Si nada
          // cambió tarda milisegundos; si hay mucho que calcular, se busca en lo que hay y la
          // pasada sigue por detrás.
          pass.catch(e => log(`index: failed: ${e?.stack || e}`))
          await Promise.race([pass.catch(() => {}), new Promise(resolve => setTimeout(resolve, FRESH_WAIT_MS))])
        }
      }
      return search({ stores: dbs.map((store, level) => ({ store, level })), embedder, reranker, query, log, ...opts })
    },
    stats: () => ({ root: dirs[0], chain: dirs, ...dbs[0].stats() }),
    close: () => { for (const d of dbs) d.close() }
  }
}
