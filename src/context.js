// Una carpeta abierta: su base, el modelo y el índice al día. El índice se refresca solo si
// pasó un rato desde la última pasada, y nunca dos pasadas a la vez.
import path from 'node:path'
import os from 'node:os'
import { Store } from './store.js'
import { createEmbedder } from './embed.js'
import { indexFolder } from './indexer.js'
import { search } from './search.js'

export const REFRESH_MS = 30_000

/**
 * @param {{ root: string, embedder?: import('./embed.js').Embedder, store?: Store, home?: string, log?: (m: string) => void, refreshMs?: number }} opts
 */
export function openContext ({ root, embedder = createEmbedder(), store, home, log = () => {}, refreshMs = REFRESH_MS }) {
  const dir = path.resolve(root)
  // Indexar la carpeta personal o la raíz recorrería todo el disco. No se intenta: se dice.
  if (dir === path.parse(dir).root || dir === path.resolve(os.homedir())) {
    throw Object.assign(new Error(`refusing to index ${dir}: pick a project folder (--root)`), { code: 'root-too-broad' })
  }
  const db = store || Store.open(dir)
  /** @type {Promise<any> | null} */
  let running = null
  let lastRun = 0

  const reindex = () => {
    if (!running) {
      running = indexFolder({ root: dir, store: db, embedder, home, log })
        .finally(() => { running = null; lastRun = Date.now() })
    }
    return running
  }

  return {
    root: dir,
    store: db,
    reindex,
    /** @param {string} query @param {{ k?: number, pathPrefix?: string }} [opts] */
    async search (query, opts = {}) {
      if (running) await running
      else if (Date.now() - lastRun > refreshMs) await reindex()
      return search({ store: db, embedder, query, ...opts })
    },
    stats: () => ({ root: dir, ...db.stats() }),
    close: () => db.close()
  }
}
