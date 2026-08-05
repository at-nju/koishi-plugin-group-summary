import { Context } from 'koishi'
import { applyChangeSet, ChangeSet, StoredMessage, Topic } from './model'

interface MessageRow extends Omit<StoredMessage, 'timestamp'> {
  timestamp: Date
  ingestedAt: Date
  processed: boolean
}

interface TopicRow extends Omit<Topic, 'createdAt' | 'updatedAt'> {
  createdAt: Date
  updatedAt: Date
}

interface StateRow {
  id: string
  dirty: boolean
  lastPublishedAt: Date | null
}

declare module 'koishi' {
  interface Tables {
    group_summary_message: MessageRow
    group_summary_topic: TopicRow
    group_summary_state: StateRow
  }
}

export function registerModels(ctx: Context) {
  ctx.model.extend('group_summary_message', {
    id: 'string',
    platformMessageId: 'string',
    channelId: 'string',
    timestamp: 'timestamp',
    author: 'json',
    text: 'text',
    images: 'json',
    links: 'json',
    ingestedAt: 'timestamp',
    processed: 'boolean',
  }, { primary: 'id' })

  ctx.model.extend('group_summary_topic', {
    id: 'string',
    title: 'string',
    summary: 'text',
    body: 'text',
    tags: 'json',
    messageIds: 'json',
    sourceMessageId: { type: 'string', nullable: true },
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
  }, { primary: 'id' })

  ctx.model.extend('group_summary_state', {
    id: 'string',
    dirty: 'boolean',
    lastPublishedAt: { type: 'timestamp', nullable: true },
  }, { primary: 'id' })
}

export async function saveMessages(ctx: Context, messages: StoredMessage[]) {
  if (!messages.length) return 0
  messages = [...new Map(messages.map(message => [message.id, message])).values()]
  const existing = await getExistingMessageIds(ctx, messages.map(message => message.id))
  const now = new Date()
  const fresh = messages.filter(message => !existing.has(message.id))
  await Promise.all(fresh.map(message => ctx.database.create('group_summary_message', {
    ...message,
    timestamp: new Date(message.timestamp),
    ingestedAt: now,
    processed: false,
  })))
  return fresh.length
}

export async function getExistingMessageIds(ctx: Context, ids: string[]) {
  if (!ids.length) return new Set<string>()
  return new Set((await ctx.database.get('group_summary_message', { id: { $in: ids } }, ['id'])).map(row => row.id))
}

export async function getPendingMessages(ctx: Context, limit: number) {
  const rows = await ctx.database.get('group_summary_message', { processed: false }, {
    limit,
    sort: { timestamp: 'asc' },
  })
  return rows.map(fromMessageRow)
}

export async function getPreviousMessages(ctx: Context, before: number, limit = 10) {
  const rows = await ctx.database.get('group_summary_message', { timestamp: { $lt: new Date(before) } }, {
    limit,
    sort: { timestamp: 'desc' },
  })
  return rows.reverse().map(fromMessageRow)
}

export async function getMessages(ctx: Context, ids: string[]) {
  if (!ids.length) return []
  return (await ctx.database.get('group_summary_message', { id: { $in: ids } })).map(fromMessageRow)
}

export async function getRecentTopics(ctx: Context, limit = 10) {
  return (await ctx.database.get('group_summary_topic', {}, {
    limit,
    sort: { updatedAt: 'desc' },
  })).map(fromTopicRow)
}

export async function getAllTopics(ctx: Context) {
  return (await ctx.database.get('group_summary_topic', {}, {
    sort: { updatedAt: 'desc' },
  })).map(fromTopicRow)
}

export async function commitChanges(ctx: Context, changes: ChangeSet, processedMessageIds: string[]) {
  await ctx.database.transact(async (database) => {
    const current = (await database.get('group_summary_topic', {})).map(fromTopicRow)
    const referencedIds = [...new Set(changes.upsert.flatMap(topic => [
      ...topic.messageIds,
      ...(topic.sourceMessageId ? [topic.sourceMessageId] : []),
    ]))]
    const knownIds = new Set((await database.get('group_summary_message', {
      id: { $in: referencedIds },
    }, ['id'])).map(row => row.id))
    const next = applyChangeSet(current, changes, knownIds)
    const currentIds = new Set(current.map(topic => topic.id))
    const changed = next.filter(topic => !currentIds.has(topic.id) || changes.upsert.some(item => item.id === topic.id))

    if (changes.remove.length) await database.remove('group_summary_topic', { id: { $in: changes.remove } })
    if (changed.length) await database.upsert('group_summary_topic', changed.map(toTopicRow))
    if (processedMessageIds.length) {
      await database.set('group_summary_message', { id: { $in: processedMessageIds } }, { processed: true })
    }
    if (changed.length || changes.remove.length) {
      await database.upsert('group_summary_state', [{ id: 'main', dirty: true, lastPublishedAt: null }])
    }
  })
}

export async function isPublishPending(ctx: Context) {
  return (await ctx.database.get('group_summary_state', { id: 'main' }))[0]?.dirty ?? false
}

export async function ensureInitialPublish(ctx: Context) {
  if (!(await ctx.database.get('group_summary_state', { id: 'main' }, ['id'])).length) {
    await ctx.database.create('group_summary_state', { id: 'main', dirty: true, lastPublishedAt: null })
  }
}

export async function markPublished(ctx: Context, timestamp = new Date()) {
  await ctx.database.upsert('group_summary_state', [{ id: 'main', dirty: false, lastPublishedAt: timestamp }])
}

function fromMessageRow(row: MessageRow): StoredMessage {
  return { ...row, timestamp: row.timestamp.getTime() }
}

function fromTopicRow(row: TopicRow): Topic {
  return { ...row, tags: Array.isArray(row.tags) ? row.tags : [], createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime() }
}

function toTopicRow(topic: Topic): TopicRow {
  return { ...topic, createdAt: new Date(topic.createdAt), updatedAt: new Date(topic.updatedAt) }
}
