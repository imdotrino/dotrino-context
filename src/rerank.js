// El reordenador: un modelo que lee la pregunta JUNTO a cada candidato y dice cuánto responde
// a ella. Los vectores encuentran candidatos; esto los ordena. Local, como todo lo demás.
import { modelCacheDir, runtime } from './paths.js'

export const DEFAULT_RERANKER = 'onnx-community/bge-reranker-v2-m3-ONNX'

/**
 * @typedef {{ model: string, score: (query: string, texts: string[]) => Promise<number[]> }} Reranker
 */

/**
 * @param {{ model?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Reranker}
 */
export function createReranker ({ model, env = process.env } = {}) {
  const id = model || env.DOTRINO_CONTEXT_RERANKER || DEFAULT_RERANKER
  const rt = runtime({ env })
  /** @type {Promise<{ tok: import('@huggingface/transformers').PreTrainedTokenizer, net: import('@huggingface/transformers').PreTrainedModel }> | null} */
  let loading = null
  const load = () => {
    if (!loading) {
      loading = (async () => {
        const t = await import('@huggingface/transformers')
        t.env.cacheDir = modelCacheDir({ env })
        const [tok, net] = await Promise.all([
          t.AutoTokenizer.from_pretrained(id),
          t.AutoModelForSequenceClassification.from_pretrained(id, { dtype: rt.dtype, device: rt.device })
        ])
        return { tok, net }
      })()
    }
    return loading
  }
  return {
    model: id,
    async score (query, texts) {
      if (!texts.length) return []
      const { tok, net } = await load()
      const inputs = tok(new Array(texts.length).fill(query), { text_pair: texts, padding: true, truncation: true, max_length: 512 })
      const { logits } = await net(inputs)
      return Array.from(/** @type {Float32Array} */ (logits.data))
    }
  }
}
