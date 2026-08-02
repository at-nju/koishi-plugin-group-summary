import { h, Universal } from 'koishi'
import { StoredMessage } from './model'

export function normalizeMessage(platform: string, channelId: string, message: Universal.Message): StoredMessage | null {
  const platformMessageId = message.id ?? message.messageId
  if (!platformMessageId) return null

  const elements = message.elements ?? h.parse(message.content ?? '')
  const images = h.select(elements, 'img').flatMap(element => {
    const sourceUrl = element.attrs.src
    return typeof sourceUrl === 'string' ? [{ sourceUrl }] : []
  })
  const text = elements.map(readElement).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  const urls = new Set<string>()
  for (const element of h.select(elements, 'a')) {
    if (typeof element.attrs.href === 'string') urls.add(element.attrs.href)
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>\[\]，。！？]+/g)) urls.add(match[0].replace(/[),.!?]+$/, ''))

  const user = message.user ?? message.member?.user
  return {
    id: `${platform}:${channelId}:${platformMessageId}`,
    platformMessageId,
    channelId,
    timestamp: message.timestamp ?? message.createdAt ?? Date.now(),
    author: {
      id: user?.id ?? 'unknown',
      name: message.member?.name ?? message.member?.nick ?? user?.name ?? user?.nick ?? '未知成员',
      avatar: message.member?.avatar ?? user?.avatar,
    },
    text: message.quote?.id ? `[回复 ${message.quote.id}] ${text}` : text,
    images,
    links: [...urls].map(url => ({ url })),
  }
}

function readElement(element: h): string {
  if (element.type === 'text') return String(element.attrs.content ?? '')
  if (element.type === 'at') return `@${element.attrs.name ?? element.attrs.id ?? ''}`
  if (element.type === 'sharp') return `#${element.attrs.name ?? element.attrs.id ?? ''}`
  if (element.type === 'img') return '[图片]'
  if (element.type === 'audio') return '[语音]'
  if (element.type === 'video') return '[视频]'
  if (element.type === 'file') return '[文件]'
  return element.children.map(readElement).join('')
}
