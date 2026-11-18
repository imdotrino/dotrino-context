#!/usr/bin/env node
// dotrino-context: la memoria y los documentos de una carpeta, buscables por significado.
import path from 'node:path'
import { parseArgs } from 'node:util'
import { openContext } from '../src/context.js'
import { serve } from '../src/mcp.js'
import { formatResults } from '../src/mcp.js'
import { VERSION } from '../src/version.js'
import { runHook } from '../src/hook.js'
import { baseChain } from '../src/paths.js'

/**
 * @typedef {Awaited<ReturnType<typeof import('../src/indexer.js').indexFolder>>} IndexResult
 * @typedef {ReturnType<ReturnType<typeof import('../src/context.js').openContext>['stats']>} Stats
 */
const kinds = (/** @type {Record<string, number>} */ k) => Object.entries(k).map(([a, b]) => `${a} ${b}`).join(', ')
const es = /^es/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '')
const t = es
  ? {
      usage: `Uso: dotrino-context <orden> [opciones]

Órdenes:
  index              indexa la carpeta (solo lo que cambió)
  search <texto>     busca en la carpeta
  status             qué hay indexado
  serve              servidor MCP para Claude Code (stdio)
  hook               hook UserPromptSubmit: añade el contexto relevante a cada mensaje

Opciones:
  --root <carpeta>   la carpeta (por defecto, la actual)
  --k <n>            cuántos resultados (search, por defecto 8)
  --version`,
      indexed: (/** @type {IndexResult} */ r, /** @type {Stats} */ s) => `${r.added} nuevos, ${r.updated} cambiados, ${r.removed} quitados, ${r.skipped} saltados · ${s.chunks} trozos (${kinds(s.byKind)})`,
      status: (/** @type {Stats} */ s) => `carpeta: ${s.root}${s.chain.length > 1 ? `\nsubcontexto: ${s.chain.slice(1).join(', ')}` : ''}\nfuentes: ${s.sources}\ntrozos: ${s.chunks} (${kinds(s.byKind)})\nmodelo: ${s.model || '—'}\nindexado: ${s.indexedAt || 'nunca'}${s.skipped.length ? `\nsaltados por tamaño (>512 KB):\n  ${s.skipped.join('\n  ')}` : ''}`,
      noQuery: 'Falta qué buscar: dotrino-context search <texto>'
    }
  : {
      usage: `Usage: dotrino-context <command> [options]

Commands:
  index              index the folder (only what changed)
  search <text>      search the folder
  status             what is indexed
  serve              MCP server for Claude Code (stdio)
  hook               UserPromptSubmit hook: adds the relevant context to each message

Options:
  --root <folder>    the folder (default: current)
  --k <n>            number of results (search, default 8)
  --version`,
      indexed: (/** @type {IndexResult} */ r, /** @type {Stats} */ s) => `${r.added} new, ${r.updated} changed, ${r.removed} removed, ${r.skipped} skipped · ${s.chunks} chunks (${kinds(s.byKind)})`,
      status: (/** @type {Stats} */ s) => `folder: ${s.root}${s.chain.length > 1 ? `\nsub-context: ${s.chain.slice(1).join(', ')}` : ''}\nsources: ${s.sources}\nchunks: ${s.chunks} (${kinds(s.byKind)})\nmodel: ${s.model || '—'}\nindexed: ${s.indexedAt || 'never'}${s.skipped.length ? `\nskipped by size (>512 KB):\n  ${s.skipped.join('\n  ')}` : ''}`,
      noQuery: 'Missing what to search: dotrino-context search <text>'
    }

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { root: { type: 'string' }, k: { type: 'string' }, version: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }
})
const [cmd, ...rest] = positionals
// Claude Code pasa la carpeta del proyecto en CLAUDE_PROJECT_DIR; si no, la actual. Esa
// carpeta tiene su base propia, y las de sus padres entran como subcontexto (baseChain).
const start = path.resolve(values.root || process.env.CLAUDE_PROJECT_DIR || process.cwd())
const root = start
const chain = baseChain(start)

async function notice () {
  const { printUpdateNotice } = await import('@dotrino/update/notice')
  await printUpdateNotice({ current: VERSION, source: 'npm', pkg: '@dotrino/context', how: 'npm i -g @dotrino/context' })
}

if (values.version) {
  console.log(VERSION)
} else if (cmd === 'serve') {
  await serve({ root, chain })
} else if (cmd === 'hook') {
  await runHook({ start })
} else if (cmd === 'index') {
  const ctx = openContext({ root, chain, log: m => process.stderr.write(`${m}\n`) })
  const r = await ctx.reindex()
  console.log(t.indexed(r, ctx.stats()))
  ctx.close()
  await notice()
} else if (cmd === 'search') {
  const q = rest.join(' ').trim()
  if (!q) { console.error(t.noQuery); process.exit(2) }
  const ctx = openContext({ root, chain, log: m => process.stderr.write(`${m}\n`) })
  console.log(formatResults(await ctx.search(q, { k: values.k ? Number(values.k) : undefined })))
  ctx.close()
  await notice()
} else if (cmd === 'status') {
  const ctx = openContext({ root, chain })
  console.log(t.status(ctx.stats()))
  ctx.close()
  await notice()
} else {
  console.log(t.usage)
  process.exit(cmd || values.help ? (values.help ? 0 : 2) : 0)
}
