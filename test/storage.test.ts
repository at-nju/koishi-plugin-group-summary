import assert from 'node:assert/strict'
import test from 'node:test'
import SQLite from '@koishijs/plugin-database-sqlite'
import { Context } from 'koishi'
import { StoredMessage } from '../src/model'
import { commitChanges, getPendingMessages, getPreviousMessages, getRecentTopics, isPublishPending, registerModels, saveMessages } from '../src/storage'

test('persists and atomically commits a batch with SQLite', async () => {
  const ctx = new Context()
  ctx.plugin(SQLite, { path: ':memory:' })
  registerModels(ctx)
  await ctx.start()

  try {
    const message: StoredMessage = {
      id: 'm1', platformMessageId: '1', channelId: '42', timestamp: 1,
      author: { id: 'u1', name: 'Alice' }, text: 'hello', images: [], links: [],
    }
    assert.equal(await saveMessages(ctx, [message, message]), 1)
    const pending = await getPendingMessages(ctx, 10)
    assert.equal(pending.length, 1)
    assert.deepEqual((await getPreviousMessages(ctx, 2)).map(item => item.id), ['m1'])

    await commitChanges(ctx, {
      upsert: [{ title: '话题', summary: '摘要', body: '正文', messageIds: ['m1'], evidenceIds: ['m1'] }],
      remove: [],
    }, ['m1'])

    assert.equal((await getPendingMessages(ctx, 10)).length, 0)
    assert.equal((await getRecentTopics(ctx))[0].title, '话题')
    assert.equal(await isPublishPending(ctx), true)
  } finally {
    await ctx.stop()
  }
})
