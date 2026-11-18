#!/usr/bin/env node
// dotrino-context: la memoria y los documentos de una carpeta, buscables por significado.
import path from 'node:path'
import { parseArgs } from 'node:util'
import { openContext } from '../src/context.js'
import { serve } from '../src/mcp.js'
import { formatResults } from '../src/mcp.js'
import { VERSION } from '../src/version.js'

const es = /^es/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '')
const t = es
  ? {
      usage: `Uso: dotrino-context <orden> [opciones]

Órdenes:
  index              indexa la carpeta (solo lo que cambió)
  search <texto>     busca en la carpeta
  status             qué hay indexado
  serve              servidor MCP para Claude Code (stdio)

Opciones:
  --root <carpeta>   la carpeta (por defecto, la actual)
  --k <n>            cuántos resultados (search, por defecto 8)
  --version`,
      indexed: (/** @type {any} */ r, /** @type {any} */ s) => `${r.added} nuevos, ${r.updated} cambiados, ${r.removed} quitados · ${s.files} archivos, ${s.chunks} trozos`,
      status: (/** @type {any} */ s) => `carpeta: ${s.root}\narchivos: ${s.files}\ntrozos: ${s.chunks}\nmodelo: ${s.model || '—'}\nindexado: ${s.indexedAt || 'nunca'}`,
      noQuery: 'Falta qué buscar: dotrino-context search <texto>'
    }
  : {
      usage: `Usage: dotrino-context <command> [options]

Commands:
  index              index the folder (only what changed)
  search <text>      search the folder
  status             what is indexed
  serve              MCP server for Claude Code (stdio)

Options:
  --root <folder>    the folder (default: current)
  --k <n>            number of results (search, default 8)
  --version`,
      indexed: (/** @type {any} */ r, /** @type {any} */ s) => `${r.added} new, ${r.updated} changed, ${r.removed} removed · ${s.files} files, ${s.chunks} chunks`,
      status: (/** @type {any} */ s) => `folder: ${s.root}\nfiles: ${s.files}\nchunks: ${s.chunks}\nmodel: ${s.model || '—'}\nindexed: ${s.indexedAt || 'never'}`,
      noQuery: 'Missing what to search: dotrino-context search <text>'
    }

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { root: { type: 'string' }, k: { type: 'string' }, version: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }
})
const [cmd, ...rest] = positionals
// Claude Code pasa la carpeta del proyecto en CLAUDE_PROJECT_DIR; si no, la actual.
const root = path.resolve(values.root || process.env.CLAUDE_PROJECT_DIR || process.cwd())

async function notice () {
  const { printUpdateNotice } = await import('@dotrino/update/notice')
  await printUpdateNotice({ current: VERSION, source: 'npm', pkg: '@dotrino/context', how: 'npm i -g @dotrino/context' })
}

if (values.version) {
  console.log(VERSION)
} else if (cmd === 'serve') {
  await serve({ root })
} else if (cmd === 'index') {
  const ctx = openContext({ root, log: m => process.stderr.write(`${m}\n`) })
  const r = await ctx.reindex()
  console.log(t.indexed(r, ctx.stats()))
  ctx.close()
  await notice()
} else if (cmd === 'search') {
  const q = rest.join(' ').trim()
  if (!q) { console.error(t.noQuery); process.exit(2) }
  const ctx = openContext({ root, log: m => process.stderr.write(`${m}\n`) })
  console.log(formatResults(await ctx.search(q, { k: values.k ? Number(values.k) : undefined })))
  ctx.close()
  await notice()
} else if (cmd === 'status') {
  const ctx = openContext({ root })
  console.log(t.status(ctx.stats()))
  ctx.close()
  await notice()
} else {
  console.log(t.usage)
  process.exit(cmd || values.help ? (values.help ? 0 : 2) : 0)
}
