import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseIgnore } from '../src/ignore.js'
import { redact } from '../src/redact.js'
import { containers, walk, cleanUserText } from '../src/sources.js'

test('ignore: basename anywhere, anchored paths, dir-only rules', () => {
  const ig = parseIgnore('# comment\nCHANGELOG.md\n/drafts/\ndocs/**/old-*.md\n')
  assert.ok(ig('a/b/CHANGELOG.md', false))
  assert.ok(ig('drafts', true))
  assert.ok(!ig('x/drafts', true))
  assert.ok(ig('docs/v1/old-plan.md', false))
  assert.ok(!ig('docs/v1/plan.md', false))
})

test('redact: known token shapes and key=value secrets', () => {
  const out = redact('key sk-ant-abcdefghijklmnopqrstuvwxyz and ghp_' + 'a'.repeat(36) + ' password=hunter22 sha 4f2a9c1e')
  assert.doesNotMatch(out, /sk-ant-abc|ghp_a|hunter22/)
  assert.match(out, /sha 4f2a9c1e/)
})

test('walk honours .dotrino-contextignore and finds repos', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dctx-'))
  fs.mkdirSync(path.join(root, 'drafts'))
  fs.writeFileSync(path.join(root, 'drafts', 'a.md'), '# a')
  fs.writeFileSync(path.join(root, 'b.md'), '# b')
  fs.writeFileSync(path.join(root, '.dotrino-contextignore'), 'drafts/\n')
  execFileSync('git', ['init', '-q', root])
  const w = walk(root)
  assert.deepEqual(w.md.map(f => path.basename(f)), ['b.md'])
  assert.deepEqual(w.repos, [root])
})

test('commit messages become one doc each', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dctx-'))
  const git = (/** @type {string[]} */ ...a) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a])
  git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', 'first: la maestra firma el acta', '-m', 'porque sí')
  git('commit', '-q', '--allow-empty', '-m', 'second')
  const c = containers(root, { home: root }).find(x => x.kind === 'git')
  assert.ok(c)
  const docs = []
  for await (const d of c.docs()) docs.push(d)
  assert.equal(docs.length, 2)
  assert.match(docs[1].chunks[0].text, /maestra firma el acta\n\nporque sí/)
  assert.match(docs[1].path, /@[0-9a-f]{10}$/)
})

test('conversations: user text and replies only, quiet files only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dctx-'))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dctx-home-'))
  const proj = path.join(home, '.claude', 'projects', path.resolve(root).replace(/[^A-Za-z0-9]/g, '-'))
  fs.mkdirSync(proj, { recursive: true })
  const lines = [
    { type: 'user', timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: '<system-reminder>noise</system-reminder>¿qué llave firma el acta?' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'secret thoughts' }, { type: 'text', text: 'La maestra.' }, { type: 'tool_use', name: 'Bash' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'tool output' }] } },
    { type: 'user', isMeta: true, message: { content: 'meta' } },
    { type: 'user', timestamp: '2026-11-01T10:05:00Z', message: { content: 'gracias, token=abcdef123456' } }
  ]
  const f = path.join(proj, 's.jsonl')
  fs.writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  const old = new Date(Date.now() - 3600_000)
  fs.utimesSync(f, old, old)
  const c = containers(root, { home }).find(x => x.kind === 'conv')
  assert.ok(c && c.stamp() !== null)
  const docs = []
  for await (const d of c.docs()) docs.push(d)
  assert.equal(docs.length, 2)
  assert.equal(docs[0].chunks[0].text, 'Usuario: ¿qué llave firma el acta?\n\nClaude: La maestra.')
  assert.equal(docs[0].date, '2026-11-01')
  assert.equal(docs[0].chunks[0].line, 1)
  assert.doesNotMatch(docs[1].chunks[0].text, /abcdef123456/)

  const fresh = containers(root, { home, now: () => Date.now() + 0 })
  fs.utimesSync(f, new Date(), new Date())
  assert.equal(fresh.find(x => x.kind === 'conv')?.stamp(), null)
})

test('cleanUserText drops command wrappers', () => {
  assert.equal(cleanUserText('<command-name>/clear</command-name>'), '')
})

test('baseChain: own folder first, then parents while they have a base', async () => {
  const { baseChain } = await import('../src/paths.js')
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'dctx-'))
  const a = path.join(top, 'a'); const b = path.join(a, 'b'); const c = path.join(b, 'c')
  fs.mkdirSync(c, { recursive: true })
  fs.mkdirSync(path.join(top, '.dotrino-context'))   // top tiene base, pero a NO: corta la cadena
  fs.mkdirSync(path.join(b, '.dotrino-context'))
  assert.deepEqual(baseChain(c), [c, b])
  assert.deepEqual(baseChain(b), [b])
  assert.deepEqual(baseChain(a), [a, top])
})

test('sessions of subfolders count only if they were opened inside the root', async () => {
  const { projectDirs } = await import('../src/sources.js')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dctx-home-'))
  const root = '/x/proj'
  const base = path.join(home, '.claude', 'projects')
  const mk = (/** @type {string} */ slug, /** @type {string} */ cwd) => { fs.mkdirSync(path.join(base, slug), { recursive: true }); fs.writeFileSync(path.join(base, slug, 's.jsonl'), JSON.stringify({ type: 'user', cwd }) + '\n') }
  mk('-x-proj', '/x/proj')
  mk('-x-proj-app', '/x/proj/app')
  mk('-x-proj-other', '/x/proj-other')            // mismo prefijo de slug, otra carpeta
  const got = projectDirs(root, { home }).map(d => path.basename(d)).sort()
  assert.deepEqual(got, ['-x-proj', '-x-proj-app'])
})
