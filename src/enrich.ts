import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { BlockList, isIP } from 'node:net'
import { extname, join } from 'node:path'
import { StoredMessage } from './model'

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(network, prefix, 'ipv6')

export async function enrichMessage(message: StoredMessage, dataDir: string): Promise<StoredMessage> {
  const links = await Promise.all(message.links.slice(0, 3).map(async ({ url }) => {
    try {
      const response = await safeFetch(url, 1_000_000)
      const html = Buffer.from(await response.arrayBuffer()).toString('utf8')
      return { url, ...extractPage(html) }
    } catch {
      return { url }
    }
  }))

  const mediaDir = join(dataDir, 'media')
  const images = await Promise.all(message.images.slice(0, 3).map(async image => {
    try {
      const response = await safeFetch(image.sourceUrl, 8_000_000)
      const bytes = Buffer.from(await response.arrayBuffer())
      const mediaType = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream'
      const suffix = extensionFor(mediaType, image.sourceUrl)
      const localPath = join(mediaDir, `${createHash('sha256').update(bytes).digest('hex')}${suffix}`)
      await mkdir(mediaDir, { recursive: true })
      await writeFile(localPath, bytes, { flag: 'wx' }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      })
      return { ...image, localPath, mediaType }
    } catch {
      return image
    }
  }))

  return { ...message, links, images }
}

async function safeFetch(source: string, maxBytes: number) {
  let url = new URL(source)
  for (let redirects = 0; redirects <= 3; redirects++) {
    await assertPublicHttpUrl(url)
    // ponytail: DNS is checked before fetch; pin resolution if the target group becomes untrusted.
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('重定向缺少地址。')
      url = new URL(location, url)
      continue
    }
    if (!response.ok) throw new Error(`下载失败：${response.status}`)
    const length = Number(response.headers.get('content-length') || 0)
    if (length > maxBytes) throw new Error('内容过大。')
    const bytes = await readLimited(response.body, maxBytes)
    return new Response(bytes, { status: response.status, headers: response.headers })
  }
  throw new Error('重定向过多。')
}

export async function assertPublicHttpUrl(url: URL) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只允许公开 HTTP 链接。')
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname, family: isIP(url.hostname) }]
    : await lookup(url.hostname, { all: true })
  if (!addresses.length || addresses.some(({ address, family }) => isBlocked(address, family))) {
    throw new Error('不允许访问私有网络。')
  }
}

function isBlocked(address: string, family: number) {
  if (address.startsWith('::ffff:')) return blocked.check(address.slice(7), 'ipv4')
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

async function readLimited(stream: ReadableStream<Uint8Array> | null, maxBytes: number) {
  if (!stream) return new Uint8Array()
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new Error('内容过大。')
    }
    chunks.push(value)
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

export function extractPage(html: string) {
  const title = decodeHtml(match(html, /<title[^>]*>([\s\S]*?)<\/title>/i))
  const description = decodeHtml(
    match(html, /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)["'][^>]*>/i)
    || match(html, /<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*>/i),
  )
  const text = decodeHtml(html
    .replace(/<(script|style|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim())
    .slice(0, 8_000)
  return { title: title || undefined, description: description || undefined, text: text || undefined }
}

function match(source: string, pattern: RegExp) {
  return pattern.exec(source)?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
}

function decodeHtml(source: string) {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return source.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (_, entity: string) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? `&${entity};`
    const hex = entity[1].toLowerCase() === 'x'
    return String.fromCodePoint(Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10))
  })
}

function extensionFor(mediaType: string, url: string) {
  const known: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }
  return known[mediaType] ?? (extname(new URL(url).pathname).slice(0, 8) || '.bin')
}
