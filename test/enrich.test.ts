import assert from 'node:assert/strict'
import test from 'node:test'
import { assertPublicHttpUrl, extractPage } from '../src/enrich'

test('rejects private link targets', async () => {
  await assert.rejects(assertPublicHttpUrl(new URL('http://127.0.0.1/admin')), /私有网络/)
  await assert.rejects(assertPublicHttpUrl(new URL('file:///etc/passwd')), /公开 HTTP/)
})

test('extracts a compact page snapshot', () => {
  assert.deepEqual(extractPage(`
    <html><head><title>News &amp; Notes</title><meta name="description" content="A short story"></head>
    <body><script>ignore()</script><h1>Hello</h1><p>World</p></body></html>
  `), {
    title: 'News & Notes',
    description: 'A short story',
    text: 'News & Notes Hello World',
  })
})
