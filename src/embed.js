// Los vectores se calculan en esta máquina, con transformers.js: nada de lo indexado sale a
// ningún servicio. El modelo se baja una vez y se queda en la caché compartida.
import { modelCacheDir, runtime } from './paths.js'

export const DEFAULT_MODEL = 'Xenova/multilingual-e5-base'
const BATCH = 16

/**
 * @typedef {{ model: string, device: string, embed: (texts: string[], kind: 'query' | 'passage') => Promise<Float32Array[]> }} Embedder
 */

/**
 * @param {{ model?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Embedder}
 */
export function createEmbedder ({ model, env = process.env } = {}) {
  const id = model || env.DOTRINO_CONTEXT_MODEL || DEFAULT_MODEL
  const rt = runtime({ env })
  /** @type {Promise<any> | null} */
  let loading = null
  const load = () => {
    if (!loading) {
      loading = (async () => {
        const t = await import('@huggingface/transformers')
        t.env.cacheDir = modelCacheDir({ env })
        return t.pipeline('feature-extraction', id, { dtype: rt.dtype, device: rt.device })
      })()
    }
    return loading
  }
  return {
    // La precisión cambia los vectores: q8 y fp16 no se mezclan en la misma base.
    model: `${id}@${rt.dtype}`,
    device: rt.device,
    async embed (texts, kind) {
      const extractor = await load()
      // Los modelos e5 se entrenaron con estos prefijos: sin ellos la búsqueda empeora.
      const prefixed = texts.map(t => `${kind}: ${t}`)
      /** @type {Float32Array[]} */
      const out = []
      for (let i = 0; i < prefixed.length; i += BATCH) {
        const res = await extractor(prefixed.slice(i, i + BATCH), { pooling: 'mean', normalize: true })
        const d = res.dims[1]
        for (let j = 0; j < res.dims[0]; j++) out.push(Float32Array.from(res.data.subarray(j * d, (j + 1) * d)))
      }
      return out
    }
  }
}
