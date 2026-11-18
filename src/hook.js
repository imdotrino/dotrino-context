// El hook UserPromptSubmit de Claude Code: con cada mensaje busca en la base de la carpeta y
// añade al contexto lo que de verdad responde a él (lo que pasa el umbral del reordenador).
// Lo que imprime por stdout entra en el contexto de ese turno.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ask } from './socket.js'
import { formatResults } from './mcp.js'
import { cleanUserText, readTurns } from './sources.js'

/**
 * ¿Hay algo que buscar? Solo, un mensaje necesita 4 palabras; con conversación detrás,
 * basta con 2, porque «sí, corre la auditoría» se entiende por lo que se habló antes. Un
 * «sí» o un «listo» a secas no añade nada a lo que ya se buscó en el turno anterior.
 * @param {string} prompt @param {boolean} hasContext
 */
export function worthSearching (prompt, hasContext = false) {
  const words = (prompt.match(/[\p{L}\p{N}]+/gu) || []).length
  return words >= (hasContext ? 2 : 4)
}

export const HOOK_K = 6
/** Cuánto de la conversación anterior entra en la consulta: lo justo para saber de qué se habla. */
export const CONTEXT_CHARS = 700
/** Cuánto del final de la transcripción se lee para sacar los últimos turnos. */
const TAIL_BYTES = 512 * 1024
/**
 * Por debajo de esta nota del reordenador (bge-reranker-v2-m3) el trozo no responde a la
 * pregunta. Medido el 2026-11-18 sobre 17.101 trozos: lo que no tiene nada que ver saca −5 o
 * menos; lo que responde, más de 1. Con 0 se colaban trozos de 0,9 en mensajes como «hazlo» o
 * «gracias, sigue»; con 1, en una batería de 28 preguntas con fuente conocida, los aciertos son
 * los mismos y esos mensajes quedan sin contexto, que es lo correcto.
 */
export const HOOK_MIN_SCORE = 1
/**
 * Corte relativo: fuera lo que queda a más de esto por debajo del mejor. Con 3 se perdían
 * fuentes vigentes (una nota de memoria a 3,0 de un commit); con 4, en 8 búsquedas medidas,
 * solo cae la cola que no aporta.
 */
export const HOOK_MAX_GAP = 4

/**
 * El turno anterior de la conversación en curso (lo último que dijo la persona y el principio
 * de lo que se le respondió), leído del final de la transcripción. Si la transcripción ya
 * trae el mensaje actual, se salta.
 * @param {string | undefined} transcript @param {string} prompt
 */
export async function previousTurn (transcript, prompt) {
  if (!transcript || !fs.existsSync(transcript)) return ''
  const size = fs.statSync(transcript).size
  const fd = fs.openSync(transcript, 'r')
  let text
  try {
    const len = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    text = buf.toString('utf8')
  } finally { fs.closeSync(fd) }
  // La primera línea puede venir cortada por la mitad: se descarta.
  const lines = text.split('\n').slice(size > TAIL_BYTES ? 1 : 0)
  /** @type {import('./sources.js').Turn[]} */
  const turns = []
  for await (const t of readTurns(lines)) turns.push(t)
  if (turns.length && turns[turns.length - 1].user === prompt) turns.pop()
  const last = turns[turns.length - 1]
  if (!last) return ''
  const reply = last.reply.join('\n\n')
  return `${last.user.slice(0, 250)}\n${reply}`.slice(0, CONTEXT_CHARS)
}

/** Lo ya inyectado en esta sesión no se repite: ya está en la conversación. */
function seenFile (/** @type {string} */ session, { env = process.env } = {}) {
  return path.join(env.XDG_RUNTIME_DIR || os.tmpdir(), `dotrino-context-seen-${session.replace(/[^\w-]/g, '')}.json`)
}
const SEEN_MAX = 200

/** @param {{ start: string, stdin?: NodeJS.ReadableStream, out?: NodeJS.WritableStream, env?: NodeJS.ProcessEnv }} opts */
export async function runHook ({ start, stdin = process.stdin, out = process.stdout, env = process.env }) {
  let raw = ''
  for await (const chunk of stdin) raw += chunk
  const input = raw ? JSON.parse(raw) : {}
  // Lo que no escribió la persona (avisos de tareas, de hooks) no se busca.
  const prompt = cleanUserText(String(input.prompt || ''))
  const before = await previousTurn(input.transcript_path, prompt)
  if (!worthSearching(prompt, !!before)) return
  // Se busca con el mensaje Y con lo que se venía hablando: el mensaje va primero (pesa más y
  // es lo último que se recorta), la conversación detrás.
  const query = before ? `${prompt.slice(0, 1200)}\n\n${before}` : prompt.slice(0, 2000)

  /** @type {{ path: string, kind: string, date: string, line: number, heading: string, text: string, level?: number }[]} */
  let results
  try {
    // El servidor es el de la carpeta donde se abrió Claude Code (CLAUDE_PROJECT_DIR), no el de
    // la carpeta a la que se haya hecho `cd` durante la sesión: esa no tiene servidor propio.
    // Él ya sabe qué bases de arriba consultar.
    results = /** @type {typeof results} */ (await ask(env.CLAUDE_PROJECT_DIR || input.cwd || start, { query, k: HOOK_K * 2, minScore: HOOK_MIN_SCORE, maxGap: HOOK_MAX_GAP }))
  } catch (e) {
    // Sin servidor no hay contexto: se dice en una línea, no se calla.
    out.write(`dotrino-context: no context added (${/** @type {Error & { code?: string }} */ (e).code || 'error'}: ${/** @type {Error} */ (e).message})\n`)
    return
  }

  const session = input.session_id ? seenFile(String(input.session_id), { env }) : null
  /** @type {string[]} */
  let seen = []
  if (session && fs.existsSync(session)) seen = JSON.parse(fs.readFileSync(session, 'utf8'))
  const key = (/** @type {{ path: string, line: number }} */ r) => `${r.path}:${r.line}`
  const fresh = results.filter(r => !seen.includes(key(r))).slice(0, HOOK_K)
  if (!fresh.length) return
  if (session) fs.writeFileSync(session, JSON.stringify([...seen, ...fresh.map(key)].slice(-SEEN_MAX)))

  out.write('Contexto relevante de dotrino-context para este mensaje y lo que se venía hablando. Cada resultado dice su tipo y fecha: doc y memory son el estado actual y ganan a git (historia); la norma de la carpeta gana a todo; entre iguales, el más nuevo. Si vas a actuar según una norma, lee la sección entera.\n\n')
  out.write(formatResults(fresh) + '\n')
}
