import assert from 'node:assert/strict'
import test from 'node:test'
import { runAgent } from '../src/agent'
import { ChangeSet, StoredMessage, Topic } from '../src/model'

const message: StoredMessage = {
  id: 'm1',
  platformMessageId: '1',
  channelId: '42',
  timestamp: 1,
  author: { id: 'u1', name: 'Alice' },
  text: '发了一条新闻',
  images: [],
  links: [],
}

const previousMessage: StoredMessage = { ...message, id: 'm0', platformMessageId: '0', timestamp: 0, text: '前情' }

test('runs a bounded read then atomic commit tool loop', async () => {
  const requests: any[] = []
  const replies = [
    { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'a', type: 'function', function: { name: 'get_recent_topics', arguments: '{}' } }] } }] },
    { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'b', type: 'function', function: { name: 'commit_changes', arguments: JSON.stringify({
      upsert: [{ title: '新闻', summary: '摘要', body: '正文', messageIds: ['m1'], evidenceIds: ['m1'] }],
      remove: [],
    }) } }] } }] },
  ]
  const request: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return Response.json(replies.shift())
  }
  let committed: ChangeSet | undefined

  await runAgent({ baseUrl: 'https://model.example/v1', apiKey: 'secret', model: 'model', maxSteps: 3, maxTokens: 2048, timeout: 1000 }, [message], {
    getRecentTopics: async () => [] as Topic[],
    getTopicContext: async () => { throw new Error('unexpected') },
    commitChanges: async changes => { committed = changes },
  }, request, [previousMessage])

  assert.equal(requests.length, 2)
  assert.equal(requests[0].max_tokens, 2048)
  assert.match(requests[0].messages[1].content[0].text, /仅用于判断讨论是否延续/)
  assert.equal(requests[1].messages.at(-1).role, 'tool')
  assert.equal(committed?.upsert[0].title, '新闻')
})
