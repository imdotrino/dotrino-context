// El hook UserPromptSubmit de Claude Code: con cada mensaje busca en la base de la carpeta y
// añade al contexto lo que de verdad responde a él (lo que pasa el umbral del reordenador).
// Lo que imprime por stdout entra en el contexto de ese turno.
import { ask } from './socket.js'
import { formatResults } from './mcp.js'

/** Mensajes como «sí» o «commitea»: no hay nada que buscar. */
export function worthSearching (/** @type {string} */ prompt) {
  const words = (prompt.match(/[\p{L}\p{N}]+/gu) || []).length
  return words >= 4
}

export const HOOK_K = 6
/**
 * Por debajo de esta nota del reordenador (bge-reranker-v2-m3) el trozo no responde a la
 * pregunta. Medido el 2026-11-18 sobre 17.101 trozos: lo que no tiene nada que ver saca −5 o
 * menos; lo que responde, más de 1.
 */
export const HOOK_MIN_SCORE = 0

/** @param {{ start: string, stdin?: NodeJS.ReadableStream, out?: NodeJS.WritableStream }} opts */
export async function runHook ({ start, stdin = process.stdin, out = process.stdout }) {
  let raw = ''
  for await (const chunk of stdin) raw += chunk
  const input = raw ? JSON.parse(raw) : {}
  const prompt = String(input.prompt || '')
  if (!worthSearching(prompt)) return
  let results
  try {
    // Cada carpeta tiene su servidor; él ya sabe qué bases de arriba consultar.
    results = await ask(input.cwd || start, { query: prompt.slice(0, 2000), k: HOOK_K, minScore: HOOK_MIN_SCORE })
  } catch (e) {
    // Sin servidor no hay contexto: se dice en una línea, no se calla.
    out.write(`dotrino-context: no context added (${/** @type {any} */ (e).code || 'error'}: ${/** @type {any} */ (e).message})\n`)
    return
  }
  if (!results.length) return
  out.write('Contexto relevante de dotrino-context para este mensaje. Cada resultado dice su tipo y fecha: doc y memory son el estado actual y ganan a git y conv (historia); la norma de la carpeta gana a todo; entre iguales, el más nuevo. Si vas a actuar según una norma, lee la sección entera.\n\n')
  out.write(formatResults(results) + '\n')
}
