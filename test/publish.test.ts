import assert from 'node:assert/strict'
import test from 'node:test'
import { StoredMessage, Topic } from '../src/model'
import { buildSnapshot, publishSnapshot } from '../src/publish'

const messages: StoredMessage[] = [
  { id: 'm1', platformMessageId: '1', channelId: '42', timestamp: 10, author: { id: 'u1', name: 'Alice' }, text: '起因', images: [], links: [{ url: 'https://example.com', title: '新闻', description: '摘要', text: '抓取的网页正文' }] },
  { id: 'm2', platformMessageId: '2', channelId: '42', timestamp: 20, author: { id: 'u2', name: 'Bob' }, text: '讨论', images: [], links: [] },
]
const topics: Topic[] = [{
  id: 't1', title: '话题', summary: '摘要', body: '正文', messageIds: ['m1', 'm2'], evidenceIds: ['m2'],
  sourceMessageId: 'm1', createdAt: 1, updatedAt: 2,
}]

test('builds public data without platform identities or images', () => {
  const snapshot = buildSnapshot(topics, messages, 30)
  assert.equal(snapshot.topics[0].activeFrom, 10)
  assert.equal(snapshot.topics[0].activeTo, 20)
  assert.deepEqual(snapshot.topics[0].source?.author, { name: 'Alice', avatar: undefined })
  assert.equal(JSON.stringify(snapshot).includes('u1'), false)
  assert.equal(JSON.stringify(snapshot).includes('images'), false)
  assert.deepEqual(snapshot.topics[0].source?.links, [{ url: 'https://example.com', title: '新闻' }])
  assert.equal(JSON.stringify(snapshot).includes('抓取的网页正文'), false)
})

test('uploads version before latest pointer', async () => {
  const writes: string[] = []
  const snapshot = buildSnapshot(topics, messages, 30)
  await publishSnapshot({ accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', prefix: 'site' }, snapshot,
    async key => { writes.push(key) })
  assert.deepEqual(writes, ['site/snapshots/30.json', 'site/latest.json'])
})
