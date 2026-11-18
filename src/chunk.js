// Parte un Markdown en trozos que se puedan buscar: uno por sección (por encabezado), y las
// secciones largas, por párrafos. Cada trozo recuerda su ruta de encabezados y su línea, que
// es lo que necesita quien lo lea para abrir el archivo en el sitio.

export const MAX_CHARS = 1200

/**
 * @typedef {{ heading: string, line: number, text: string }} Chunk
 */

/**
 * Quita el frontmatter (`---` … `---`) y devuelve su `description`, si la tiene: en la
 * memoria de Claude es la línea que mejor resume la nota.
 * @param {string} src
 * @returns {{ body: string, description: string | null, offset: number }}
 */
export function stripFrontmatter (src) {
  if (!src.startsWith('---\n')) return { body: src, description: null, offset: 0 }
  const end = src.indexOf('\n---', 4)
  if (end < 0) return { body: src, description: null, offset: 0 }
  const fm = src.slice(4, end)
  const m = fm.match(/^description:\s*(.+)$/m)
  const after = src.indexOf('\n', end + 4)
  const rest = after < 0 ? '' : src.slice(after + 1)
  const offset = src.slice(0, src.length - rest.length).split('\n').length - 1
  return { body: rest, description: m ? m[1].trim() : null, offset }
}

/**
 * @param {string} src  el Markdown entero
 * @param {{ title?: string }} [opts]  `title`: el nombre del archivo, para el trozo sin encabezado
 * @returns {Chunk[]}
 */
export function chunkMarkdown (src, { title = '' } = {}) {
  const { body, description, offset } = stripFrontmatter(src.replace(/\r\n/g, '\n'))
  const lines = body.split('\n')
  /** @type {{ heading: string, line: number, lines: string[] }[]} */
  const sections = []
  /** @type {string[]} */
  const stack = []
  let cur = { heading: title, line: offset + 1, lines: /** @type {string[]} */ ([]) }
  let fence = false
  lines.forEach((ln, i) => {
    if (/^\s*(```|~~~)/.test(ln)) fence = !fence
    const h = !fence && ln.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      sections.push(cur)
      const level = h[1].length
      stack.length = level - 1
      stack[level - 1] = h[2].trim()
      cur = { heading: stack.filter(Boolean).join(' > '), line: offset + i + 1, lines: [] }
    } else {
      cur.lines.push(ln)
    }
  })
  sections.push(cur)

  /** @type {Chunk[]} */
  const out = []
  for (const s of sections) {
    const text = s.lines.join('\n').trim()
    if (!text) continue
    for (const piece of splitLong(text)) out.push({ heading: s.heading, line: s.line, text: piece })
  }
  if (description) {
    if (out.length) out[0].text = `${description}\n\n${out[0].text}`
    else out.push({ heading: title, line: 1, text: description })
  }
  return out
}

/**
 * Una sección más larga que MAX_CHARS se corta por párrafos, juntándolos hasta el tope. Un
 * párrafo que solo ya pasa el tope se corta a lo bruto: mejor eso que perderlo.
 * @param {string} text
 */
export function splitLong (text) {
  if (text.length <= MAX_CHARS) return [text]
  const out = []
  let buf = ''
  for (const para of text.split(/\n\s*\n/)) {
    if (buf && (buf.length + para.length + 2) > MAX_CHARS) { out.push(buf); buf = '' }
    if (para.length > MAX_CHARS) {
      for (let i = 0; i < para.length; i += MAX_CHARS) out.push(para.slice(i, i + MAX_CHARS))
      continue
    }
    buf = buf ? `${buf}\n\n${para}` : para
  }
  if (buf) out.push(buf)
  return out
}
