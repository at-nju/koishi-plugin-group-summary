import assert from 'node:assert/strict'
import test from 'node:test'
import { applyChangeSet, Topic } from '../src/model'

const topic: Topic = {
  id: 'old',
  title: '旧标题',
  summary: '旧摘要',
  body: '旧正文',
  messageIds: ['m1'],
  evidenceIds: ['m1'],
  createdAt: 1,
  updatedAt: 1,
}

test('atomically validates and applies topic changes', () => {
  const result = applyChangeSet([topic], {
    upsert: [{
      id: 'old',
      title: '新标题',
      summary: '新摘要',
      body: '新正文',
      messageIds: ['m1', 'm2'],
      evidenceIds: ['m2'],
      sourceMessageId: 'm1',
    }],
    remove: [],
  }, new Set(['m1', 'm2']), 2)

  assert.equal(result[0].createdAt, 1)
  assert.equal(result[0].updatedAt, 2)
  assert.deepEqual(result[0].messageIds, ['m1', 'm2'])
})

test('rejects a message assigned to two topics', () => {
  assert.throws(() => applyChangeSet([topic], {
    upsert: [{
      title: '另一个话题',
      summary: '摘要',
      body: '正文',
      messageIds: ['m1'],
      evidenceIds: [],
    }],
    remove: [],
  }, new Set(['m1']), 2, () => 'new'), /同时属于话题/)
})

test('limits public evidence to a few messages', () => {
  const messageIds = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']
  assert.throws(() => applyChangeSet([], {
    upsert: [{ title: '话题', summary: '摘要', body: '正文', messageIds, evidenceIds: messageIds }],
    remove: [],
  }, new Set(messageIds)), /最多包含 5 条依据/)
})
