import { test } from 'node:test'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.js'
import { openContext } from '../src/context.js'
import { ftsQuery } from '../src/search.js'

// Un modelo falso y determinista: bolsa de palabras con hash, normalizada. Basta para probar
// el camino entero sin bajar el modelo de verdad.
function fakeEmbedder () {
  const dims = 64
  return {
    model: 'fake',
    dims,
    async embed (/** @type {string[]} */ texts) {
      return texts.map(t => {
        const v = new Float32Array(dims)
        for (const w of t.toLowerCase().match(/\p{L}+/gu) || []) {
          let h = 0
          for (const ch of w) h = (h * 31 + ch.codePointAt(0)) >>> 0
          v[h % dims] += 1
        }
        const n = Math.hypot(...v) || 1
        return v.map(x => x / n)
      })
    }
  }
}

function tmpFolder () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dctx-'))
  fs.mkdirSync(path.join(dir, 'docs'))
  fs.writeFileSync(path.join(dir, 'docs', 'vault.md'), '# Bóveda\n## Maestra\nLa maestra solo firma el acta.\n')
  fs.writeFileSync(path.join(dir, 'README.md'), '# Tema\nEl tema usa tokens dt.\n')
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'skip.md'), 'maestra maestra')
  return dir
}

test('fts query quotes every word, so nothing is read as an operator', () => {
  assert.equal(ftsQuery('acta OR "x" - y'), '"acta" OR "OR"')
})

test('indexes, skips node_modules, finds by word and reindexes changes', async () => {
  const root = tmpFolder()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dctx-home-'))
  const mem = path.join(home, '.claude', 'projects', path.resolve(root).replace(/[^A-Za-z0-9]/g, '-'), 'memory')
  fs.mkdirSync(mem, { recursive: true })
  fs.writeFileSync(path.join(mem, 'nota.md'), '---\ndescription: recordatorio del acta\n---\ntexto\n')

  const ctx = openContext({ root, embedder: fakeEmbedder(), reranker: null, stores: [new Store(':memory:')], home, refreshMs: 0 })
  const r1 = await ctx.reindex()
  assert.equal(r1.added, 3)
  const hits = await ctx.search('maestra acta')
  assert.ok(hits.length >= 1)
  assert.equal(path.basename(hits[0].path), 'vault.md')
  assert.ok(!hits.some(h => h.path.includes('node_modules')))
  assert.ok(hits.some(h => h.path.endsWith('nota.md')))

  const r2 = await ctx.reindex()
  assert.deepEqual([r2.added, r2.updated, r2.removed], [0, 0, 0])

  fs.rmSync(path.join(root, 'README.md'))
  const r3 = await ctx.reindex()
  assert.equal(r3.removed, 1)
  assert.equal(ctx.stats().byKind.memory, 1)
  ctx.close()
})

test('the context folder ignores itself in git', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dctx-'))
  const s = Store.open(root)
  s.close()
  assert.equal(fs.readFileSync(path.join(root, '.dotrino-context', '.gitignore'), 'utf8'), '*\n')
})

test('refuses to index the home folder', () => {
  assert.throws(() => openContext({ root: os.homedir(), embedder: fakeEmbedder(), reranker: null, stores: [new Store(':memory:')] }), { code: 'root-too-broad' })
})

test('a base from another schema version is thrown away and rebuilt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dctx-'))
  const file = path.join(dir, 'index.db')
  const { DatabaseSync } = require('node:sqlite')
  const old = new DatabaseSync(file)
  old.exec("create table meta (key text primary key, value text); insert into meta values ('schema', '1'); create table chunks (id integer primary key, path text);")
  old.close()
  const s = new Store(file)
  assert.equal(s.getMeta('schema'), '2')
  assert.equal(s.stats().chunks, 0)
  s.close()
})

test('the reranker reorders and the threshold drops what does not answer', async () => {
  const root = tmpFolder()
  const reranker = { model: 'fake', async score (/** @type {string} */ _q, /** @type {string[]} */ texts) { return texts.map(t => t.includes('tokens dt') ? 5 : -10) } }
  const ctx = openContext({ root, embedder: fakeEmbedder(), reranker, stores: [new Store(':memory:')], home: root, refreshMs: 0 })
  await ctx.reindex()
  const hits = await ctx.search('maestra acta tema', { minScore: 0 })
  assert.equal(hits.length, 1)
  assert.equal(path.basename(hits[0].path), 'README.md')
  ctx.close()
})

test('own base first, parent bases as sub-context, duplicates kept from the nearest', async () => {
  const parent = tmpFolder()
  const child = path.join(parent, 'docs')
  const reranker = { model: 'fake', async score (/** @type {string} */ _q, /** @type {string[]} */ texts) { return texts.map(() => 1) } }
  const own = new Store(':memory:'); const up = new Store(':memory:')
  const ctx = openContext({ root: child, chain: [child, parent], embedder: fakeEmbedder(), reranker, stores: [own, up], home: parent, refreshMs: 0 })
  await ctx.reindex()
  const hits = await ctx.search('maestra acta tema', { k: 5 })
  // vault.md está en las dos bases: sale una vez, de la propia (nivel 0), y primero.
  assert.equal(hits.filter(h => h.path.endsWith('vault.md')).length, 1)
  assert.equal(path.basename(hits[0].path), 'vault.md')
  assert.equal(hits[0].level, 0)
  // README.md solo está en la del padre: llega como subcontexto.
  assert.equal(hits.find(h => h.path.endsWith('README.md'))?.level, 1)
  ctx.close()
})

test('relative cut: what falls far below the best is dropped', async () => {
  const root = tmpFolder()
  const reranker = { model: 'fake', async score (/** @type {string} */ _q, /** @type {string[]} */ texts) { return texts.map(t => t.includes('maestra') ? 6 : 1) } }
  const ctx = openContext({ root, embedder: fakeEmbedder(), reranker, stores: [new Store(':memory:')], home: root, refreshMs: 0 })
  await ctx.reindex()
  const all = await ctx.search('maestra tema', { minScore: 0 })
  const cut = await ctx.search('maestra tema', { minScore: 0, maxGap: 4 })
  assert.ok(all.length > cut.length)
  assert.ok(cut.every(h => h.text.includes('maestra')))
  ctx.close()
})

test('at most two chunks per document, and memory ranks over a doc at equal answer', async () => {
  const { search } = await import('../src/search.js')
  const store = new Store(':memory:')
  store.ensureModel('fake')
  const emb = fakeEmbedder()
  const put = async (/** @type {string} */ key, /** @type {string} */ p, /** @type {string} */ kind, /** @type {string} */ text) => {
    const [v] = await emb.embed([text])
    store.putDoc(p, kind, { key, path: p, version: key, date: 'd', chunks: [{ heading: 'h', line: 1, text }] }, [v])
  }
  for (let i = 0; i < 4; i++) await put(`d${i}`, '/big.md', 'doc', `npm trust caducó otra vez ${i}`)
  await put('m', '/memory/npm.md', 'memory', 'npm trust se aprueba con la passkey')
  const reranker = { model: 'fake', async score (/** @type {string} */ _q, /** @type {string[]} */ t) { return t.map(() => 1) } }
  const hits = await search({ stores: [{ store, level: 0 }], embedder: { ...emb, model: 'fake' }, reranker, query: 'npm trust', k: 6 })
  assert.equal(hits.filter(h => h.path === '/big.md').length, 2)
  assert.equal(hits[0].kind, 'memory')
})

test('a base built with another model is not wiped unless asked', () => {
  const s = new Store(':memory:')
  assert.equal(s.ensureModel('m@fp16'), true)
  assert.equal(s.ensureModel('m@fp16'), false)
  assert.throws(() => s.ensureModel('m@q8'), e => e.code === 'model-mismatch')
  assert.equal(s.getMeta('model'), 'm@fp16')
  assert.equal(s.ensureModel('m@q8', { rebuild: true }), true)
  assert.equal(s.getMeta('model'), 'm@q8')
})
