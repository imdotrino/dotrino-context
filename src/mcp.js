// El servidor MCP: lo que Claude Code ve. Dos herramientas, `search` y `reindex`. La lectura
// del archivo la hace Claude con su Read, con la ruta y la línea que le damos.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { openContext } from './context.js'
import { VERSION } from './version.js'
import { listen } from './socket.js'

/**
 * @param {{ path: string, kind: string, date: string, line: number, heading: string, text: string, level?: number }[]} results
 */
export function formatResults (results) {
  if (!results.length) return 'No results.'
  // Dos trozos de la misma sección (una sección larga partida en dos) se enseñan juntos.
  /** @type {typeof results} */
  const merged = []
  for (const r of results) {
    const same = merged.find(m => m.path === r.path && m.line === r.line && m.heading === r.heading)
    if (same) same.text = `${same.text}\n\n${r.text}`
    else merged.push({ ...r })
  }
  return merged.map((r, i) => {
    const from = r.level ? ` · contexto de arriba` : ''
    const where = `[${r.kind} ${r.date}${from}] ${r.line ? `${r.path}:${r.line}` : r.path}`
    const head = r.heading ? ` — ${r.heading}` : ''
    return `[${i + 1}] ${where}${head}\n${r.text}`
  }).join('\n\n')
}

/** @param {{ root: string, chain?: string[] }} opts */
export async function serve ({ root, chain }) {
  const ctx = openContext({ root, chain, log: m => process.stderr.write(`${m}\n`) })
  const server = new McpServer({ name: 'dotrino-context', version: VERSION })

  server.registerTool('search', {
    title: 'Search folder context',
    description: 'Semantic + keyword search over this folder: its Markdown (docs, wiki, norms), its Claude Code memory notes and the git commit messages of its repos. Each result says its kind (doc, memory, git) and date. Results come from this folder\'s own base and, as sub-context, from the bases of its parent folders (marked «contexto de arriba»); this folder\'s own come first. Results can disagree: a doc or memory note is the current state and wins over a commit, which is history; the folder\'s CLAUDE.md and norm files win over everything; between two of the same kind, the newer one wins. Use it before opening files; Read the file at path:line before acting on a norm. For git results, `git -C <repo> show <sha>`.',
    inputSchema: {
      query: z.string().min(2).describe('What you are looking for, in natural language or exact terms'),
      k: z.number().int().min(1).max(30).optional().describe('How many results (default 8)'),
      path: z.string().optional().describe('Only results whose absolute path starts with this prefix')
    }
  }, async ({ query, k, path }) => {
    const results = await ctx.search(query, { k, pathPrefix: path })
    return { content: [{ type: 'text', text: formatResults(results) }] }
  })

  server.registerTool('reindex', {
    title: 'Reindex folder context',
    description: 'Re-scan this folder and re-embed what changed. Search already refreshes on its own every 30 s; call this right after writing a memory note or a doc you want to find immediately.',
    inputSchema: {}
  }, async () => {
    const r = await ctx.reindex()
    const s = ctx.stats()
    return { content: [{ type: 'text', text: `added ${r.added}, updated ${r.updated}, removed ${r.removed}, skipped ${r.skipped}; ${s.sources} sources, ${s.chunks} chunks` }] }
  })

  // El primer índice se arranca enseguida, por detrás: la primera búsqueda lo espera.
  ctx.reindex().catch(e => process.stderr.write(`index: failed: ${e?.stack || e}\n`))
  // El socket del hook de cada mensaje: la misma búsqueda, con los modelos ya cargados.
  await listen(ctx.root, req => ctx.search(String(req.query || ''), { k: req.k, minScore: req.minScore, maxGap: req.maxGap }), m => process.stderr.write(`${m}\n`))
  const transport = new StdioServerTransport()
  // Cuando Claude Code se cierra, se cierra su entrada: el servidor se va con él, y suelta la
  // GPU y el socket. Sin esto quedaba vivo por el socket.
  transport.onclose = () => process.exit(0)
  process.stdin.once('end', () => process.exit(0))
  await server.connect(transport)
}
