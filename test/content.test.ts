import assert from 'node:assert/strict'
import test from 'node:test'
import { h } from 'koishi'
import { normalizeMessage } from '../src/content'

test('normalizes text, images, links and member identity', () => {
  const message = normalizeMessage('onebot', '42', {
    id: '7',
    timestamp: 10,
    user: { id: '1', name: '账号名' },
    member: { name: '群昵称', avatar: 'https://example.com/avatar.png' },
    elements: [
      h.text('看看 https://example.com/news。'),
      h.image('https://example.com/image.png'),
    ],
  })

  assert.deepEqual(message, {
    id: 'onebot:42:7',
    platformMessageId: '7',
    channelId: '42',
    timestamp: 10,
    author: { id: '1', name: '群昵称', avatar: 'https://example.com/avatar.png' },
    text: '看看 https://example.com/news。 [图片]',
    images: [{ sourceUrl: 'https://example.com/image.png' }],
    links: [{ url: 'https://example.com/news' }],
  })
})
