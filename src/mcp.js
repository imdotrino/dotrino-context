// El servidor MCP: lo que Claude Code ve. Dos herramientas, `search` y `reindex`. La lectura
// del archivo la hace Claude con su Read, con la ruta y la línea que le damos.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { openContext } from './context.js'
import { VERSION } from './version.js'

/**
 * @param {{ path: string, line: number, heading: string, text: string }[]} results
 */
export function formatResults (results) {
  if (!results.length) return 'No results.'
  return results.map((r, i) => {
    const where = `${r.path}:${r.line}`
    const head = r.heading ? ` — ${r.heading}` : ''
    const body = r.text.length > 700 ? `${r.text.slice(0, 700)}…` : r.text
    return `[${i + 1}] ${where}${head}\n${body}`
  }).join('\n\n')
}

/** @param {{ root: string }} opts */
export async function serve ({ root }) {
  const ctx = openContext({ root, log: m => process.stderr.write(`${m}\n`) })
  const server = new McpServer({ name: 'dotrino-context', version: VERSION })

  server.registerTool('search', {
    title: 'Search folder context',
    description: 'Semantic + keyword search over this folder\'s Markdown (docs, wiki, norms) and its Claude Code memory notes. Returns path:line, heading and the matching text. Use it before answering questions about past decisions, design docs or how something works in this folder; then Read the file at that line if you need more.',
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
    return { content: [{ type: 'text', text: `added ${r.added}, updated ${r.updated}, removed ${r.removed}; ${s.files} files, ${s.chunks} chunks` }] }
  })

  // El primer índice se arranca enseguida, por detrás: la primera búsqueda lo espera.
  ctx.reindex().catch(e => process.stderr.write(`index: failed: ${e?.stack || e}\n`))
  await server.connect(new StdioServerTransport())
}
