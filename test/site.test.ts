import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHTML } from 'linkedom'
import { PublishedSnapshot } from '../src/publish'

test('renders safe paged topics with nearby evidence', async () => {
  const { document, window } = parseHTML(`
    <meta name="group-summary-data" content="https://data.example.com/group-summary">
    <p id="status"></p><section id="topics"></section><button id="more" hidden></button>
  `)
  Object.assign(globalThis, {
    document,
    window,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLAnchorElement: window.HTMLAnchorElement,
  })

  const evidence = { id: 'm1', timestamp: 1, author: { name: 'Alice' }, text: '依据原文', links: [] }
  const topics = Array.from({ length: 21 }, (_, index) => ({
    id: `t${index}`,
    title: `话题 ${index}`,
    summary: '摘要',
    body: index ? '正文' : '<script>bad()</script>结论\n\n{{evidence:m1}}\n\n[外链](https://example.com)',
    activeFrom: 1,
    activeTo: 2,
    evidence: index ? [] : [evidence],
  }))
  const snapshot: PublishedSnapshot = { version: '1', generatedAt: 2, topics }
  globalThis.fetch = async url => Response.json(String(url).endsWith('latest.json')
    ? { snapshot: 'snapshots/1.json' }
    : snapshot)

  const { loadPromise } = await import('../site/app')
  await loadPromise

  assert.equal(document.querySelectorAll('details').length, 20)
  document.querySelector<HTMLButtonElement>('#more')!.click()
  assert.equal(document.querySelectorAll('details').length, 21)
  assert.equal(document.querySelector('script'), null)
  assert.equal(document.querySelector('.message-label')?.textContent, '依据')
  const link = document.querySelector<HTMLAnchorElement>('.markdown a')!
  assert.equal(link.target, '_blank')
  assert.equal(link.rel, 'noopener noreferrer')
})
