import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkMarkdown, splitLong, MAX_CHARS } from '../src/chunk.js'

test('splits by heading and keeps the heading path and line', () => {
  const src = '# A\nintro\n## B\nbody b\n```\n# not a heading\n```\n### C\nbody c\n'
  const c = chunkMarkdown(src)
  assert.deepEqual(c.map(x => [x.heading, x.line]), [['A', 1], ['A > B', 3], ['A > B > C', 8]])
  assert.match(c[1].text, /# not a heading/)
})

test('frontmatter description goes into the first chunk, lines stay right', () => {
  const src = '---\nname: x\ndescription: one line summary\n---\n\nbody\n## H\nmore\n'
  const c = chunkMarkdown(src, { title: 'note' })
  assert.equal(c[0].heading, 'note')
  assert.match(c[0].text, /^one line summary/)
  assert.equal(c[1].line, 7)
})

test('long sections are split by paragraph under the limit', () => {
  const para = 'x'.repeat(500)
  const parts = splitLong([para, para, para, para].join('\n\n'))
  assert.ok(parts.length >= 2)
  for (const p of parts) assert.ok(p.length <= MAX_CHARS)
})
