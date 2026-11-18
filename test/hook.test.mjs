import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { listen } from '../src/socket.js'
import { runHook, worthSearching } from '../src/hook.js'

const sink = () => { let s = ''; const w = new Writable({ write (c, _e, cb) { s += c; cb() } }); return { w, get: () => s } }

test('short prompts are not searched', () => {
  assert.equal(worthSearching('sí, commitea'), false)
  assert.equal(worthSearching('qué llave firma el acta'), true)
})

test('hook asks the server over the socket and prints the results', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dctx-'))
  const server = await listen(root, async req => [{ path: '/x.md', kind: 'doc', date: '2026-11-18', heading: 'H', line: 3, text: `answer to ${req.query}` }], () => {})
  const out = sink()
  await runHook({ start: root, env: {}, stdin: Readable.from([JSON.stringify({ prompt: 'qué llave firma el acta', cwd: root })]), out: out.w })
  assert.match(out.get(), /\[doc 2026-11-18\] \/x\.md:3 — H\nanswer to qué llave firma el acta/)
  server?.close()
})

test('without a server the hook says so in one line', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dctx-'))
  const out = sink()
  await runHook({ start: root, env: {}, stdin: Readable.from([JSON.stringify({ prompt: 'qué llave firma el acta', cwd: root })]), out: out.w })
  assert.match(out.get(), /^dotrino-context: no context added \(no-server/)
})

test('two chunks of the same section are shown together', async () => {
  const { formatResults } = await import('../src/mcp.js')
  const out = formatResults([
    { path: '/a.md', kind: 'doc', date: 'd', heading: 'H', line: 5, text: 'one' },
    { path: '/b.md', kind: 'doc', date: 'd', heading: 'X', line: 1, text: 'other' },
    { path: '/a.md', kind: 'doc', date: 'd', heading: 'H', line: 5, text: 'two' }
  ])
  assert.match(out, /\[1\] .*\/a\.md:5 — H\none\n\ntwo/)
  assert.match(out, /\[2\] .*\/b\.md:1/)
})

test('the hook asks the server of the project folder, not of the cwd after a cd', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'dctx-'))
  const server = await listen(project, async () => [{ path: '/p.md', kind: 'doc', date: 'd', heading: 'H', line: 1, text: 'from project' }], () => {})
  const out = sink()
  await runHook({ start: project, env: { CLAUDE_PROJECT_DIR: project }, stdin: Readable.from([JSON.stringify({ prompt: 'qué llave firma el acta', cwd: path.join(project, 'sub') })]), out: out.w })
  assert.match(out.get(), /from project/)
  server?.close()
})

test('task notifications and hook feedback are not searched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dctx-'))
  const out = sink()
  const prompt = '<task-notification>\n<task-id>x</task-id>\n<summary>Background command "publicar el paquete en npm" completed</summary>\n</task-notification>'
  await runHook({ start: root, env: {}, stdin: Readable.from([JSON.stringify({ prompt, cwd: root })]), out: out.w })
  await runHook({ start: root, env: {}, stdin: Readable.from([JSON.stringify({ prompt: 'Stop hook feedback:\n[bash x]: La tarjeta de esta consola quedó vieja', cwd: root })]), out: out.w })
  assert.equal(out.get(), '')
})
