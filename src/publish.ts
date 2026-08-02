import { AwsClient } from 'aws4fetch'
import { StoredMessage, Topic } from './model'

export interface R2Config {
  accountId: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  prefix: string
}

export interface PublishedMessage {
  id: string
  timestamp: number
  author: { name: string, avatar?: string }
  text: string
  links: StoredMessage['links']
}

export interface PublishedTopic {
  id: string
  title: string
  summary: string
  body: string
  activeFrom: number
  activeTo: number
  source?: PublishedMessage
  evidence: PublishedMessage[]
}

export interface PublishedSnapshot {
  version: string
  generatedAt: number
  topics: PublishedTopic[]
}

export function buildSnapshot(topics: Topic[], messages: StoredMessage[], generatedAt = Date.now()): PublishedSnapshot {
  const byId = new Map(messages.map(message => [message.id, message]))
  const published = topics.flatMap(topic => {
    const topicMessages = topic.messageIds.map(id => byId.get(id)).filter((item): item is StoredMessage => !!item)
    if (!topicMessages.length) return []
    const timestamps = topicMessages.map(message => message.timestamp)
    return [{
      id: topic.id,
      title: topic.title,
      summary: topic.summary,
      body: topic.body,
      activeFrom: Math.min(...timestamps),
      activeTo: Math.max(...timestamps),
      source: topic.sourceMessageId && byId.has(topic.sourceMessageId)
        ? toPublishedMessage(byId.get(topic.sourceMessageId)!)
        : undefined,
      evidence: topic.evidenceIds.flatMap(id => {
        const message = byId.get(id)
        return message ? [toPublishedMessage(message)] : []
      }),
    }]
  }).sort((a, b) => b.activeTo - a.activeTo)

  return { version: String(generatedAt), generatedAt, topics: published }
}

export async function publishSnapshot(
  config: R2Config,
  snapshot: PublishedSnapshot,
  upload = createUploader(config),
) {
  const prefix = config.prefix.replace(/^\/+|\/+$/g, '')
  const snapshotKey = [prefix, 'snapshots', `${snapshot.version}.json`].filter(Boolean).join('/')
  await upload(snapshotKey, JSON.stringify(snapshot), 'public, max-age=31536000, immutable')
  await upload([prefix, 'latest.json'].filter(Boolean).join('/'), JSON.stringify({
    version: snapshot.version,
    snapshot: snapshotKey.slice(prefix ? prefix.length + 1 : 0),
  }), 'no-cache')
}

function createUploader(config: R2Config) {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: 'auto',
    retries: 2,
  })
  const endpoint = `https://${config.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(config.bucket)}`
  return async (key: string, body: string, cacheControl: string) => {
    const path = key.split('/').map(encodeURIComponent).join('/')
    const response = await client.fetch(`${endpoint}/${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cacheControl },
      body,
    })
    if (!response.ok) throw new Error(`R2 上传失败：${response.status} ${(await response.text()).slice(0, 300)}`)
  }
}

function toPublishedMessage(message: StoredMessage): PublishedMessage {
  return {
    id: message.id,
    timestamp: message.timestamp,
    author: { name: message.author.name, avatar: message.author.avatar },
    text: message.text,
    links: message.links,
  }
}
