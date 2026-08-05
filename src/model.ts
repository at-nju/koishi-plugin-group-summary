import { randomUUID } from 'node:crypto'

export interface Author {
  id: string
  name: string
  avatar?: string
}

export interface StoredImage {
  sourceUrl: string
  localPath?: string
  mediaType?: string
}

export interface LinkSnapshot {
  url: string
  title?: string
  description?: string
  text?: string
}

export interface StoredMessage {
  id: string
  platformMessageId: string
  channelId: string
  timestamp: number
  author: Author
  text: string
  images: StoredImage[]
  links: LinkSnapshot[]
}

export interface Topic {
  id: string
  title: string
  summary: string
  body: string
  tags: string[]
  messageIds: string[]
  sourceMessageId?: string
  createdAt: number
  updatedAt: number
}

export interface TopicDraft extends Omit<Topic, 'id' | 'createdAt' | 'updatedAt'> {
  id?: string
}

export interface ChangeSet {
  upsert: TopicDraft[]
  remove: string[]
}

export function applyChangeSet(
  current: Topic[],
  changes: ChangeSet,
  knownMessageIds: Set<string>,
  now = Date.now(),
  createId = randomUUID,
) {
  const topics = new Map(current.map(topic => [topic.id, topic]))

  if (new Set(changes.remove).size !== changes.remove.length) throw new Error('重复删除话题。')
  for (const id of changes.remove) {
    if (!topics.delete(id)) throw new Error(`话题不存在：${id}`)
  }

  for (const draft of changes.upsert) {
    const previous = draft.id ? topics.get(draft.id) : undefined
    if (draft.id && !previous) throw new Error(`话题不存在：${draft.id}`)
    if (!draft.title.trim() || !draft.summary.trim() || !draft.body.trim()) throw new Error('话题内容不能为空。')
    if (!draft.messageIds.length) throw new Error('话题必须包含消息。')
    if (new Set(draft.messageIds).size !== draft.messageIds.length) throw new Error('话题包含重复消息。')

    const messageIds = new Set(draft.messageIds)
    for (const id of draft.messageIds) {
      if (!knownMessageIds.has(id)) throw new Error(`消息不存在：${id}`)
    }
    if (draft.sourceMessageId && !messageIds.has(draft.sourceMessageId)) throw new Error('话题源必须属于话题。')

    const id = draft.id ?? createId()
    topics.set(id, {
      ...draft,
      id,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    })
  }

  const owners = new Map<string, string>()
  for (const topic of topics.values()) {
    for (const messageId of topic.messageIds) {
      const owner = owners.get(messageId)
      if (owner) throw new Error(`消息 ${messageId} 同时属于话题 ${owner} 和 ${topic.id}。`)
      owners.set(messageId, topic.id)
    }
  }

  return [...topics.values()]
}
