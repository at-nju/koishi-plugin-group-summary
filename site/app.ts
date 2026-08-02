import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { PublishedMessage, PublishedSnapshot, PublishedTopic } from '../src/publish'

marked.use({
  gfm: true,
  breaks: true,
  renderer: { html: ({ text }) => escapeHtml(text) },
})

const status = document.querySelector<HTMLParagraphElement>('#status')!
const topics = document.querySelector<HTMLElement>('#topics')!
const more = document.querySelector<HTMLButtonElement>('#more')!
const base = document.querySelector<HTMLMetaElement>('meta[name="group-summary-data"]')!.content.replace(/\/$/, '')
const pageSize = 20
let snapshot: PublishedSnapshot
let shown = 0

void load().catch(error => {
  status.textContent = `加载失败：${error instanceof Error ? error.message : String(error)}`
})

more.addEventListener('click', renderNext)

async function load() {
  const pointer = await getJson<{ snapshot: string }>(`${base}/latest.json`, 'no-store')
  snapshot = await getJson<PublishedSnapshot>(`${base}/${pointer.snapshot}`, 'force-cache')
  status.textContent = snapshot.topics.length
    ? `更新于 ${formatTime(snapshot.generatedAt)}`
    : '暂时还没有形成可见话题。'
  renderNext()
}

function renderNext() {
  const next = snapshot.topics.slice(shown, shown + pageSize)
  topics.append(...next.map(topicCard))
  shown += next.length
  more.hidden = shown >= snapshot.topics.length
}

function topicCard(topic: PublishedTopic) {
  const details = el('details', 'topic')
  const heading = el('summary', 'topic-heading')
  const title = el('span', 'topic-title', topic.title)
  const summary = el('span', 'topic-summary', topic.summary)
  const time = el('time', 'topic-time', formatRange(topic.activeFrom, topic.activeTo))
  heading.append(title, summary, time)

  const body = el('div', 'topic-body')
  const markdown = el('div', 'markdown')
  markdown.innerHTML = DOMPurify.sanitize(String(marked.parse(topic.body)))
  secureLinks(markdown)
  body.append(markdown)
  if (topic.source) body.append(messageCard(topic.source, '话题源'))
  if (topic.evidence.length) {
    const evidence = el('section', 'evidence')
    evidence.append(el('h2', '', '依据消息'), ...topic.evidence.map(message => messageCard(message)))
    body.append(evidence)
  }
  details.append(heading, body)
  return details
}

function messageCard(message: PublishedMessage, label?: string) {
  const card = el('blockquote', 'message')
  if (label) card.append(el('strong', 'message-label', label))
  const meta = el('div', 'message-meta')
  if (message.author.avatar) {
    const avatar = document.createElement('img')
    avatar.src = message.author.avatar
    avatar.alt = ''
    avatar.loading = 'lazy'
    meta.append(avatar)
  }
  meta.append(el('span', '', message.author.name), el('time', '', formatTime(message.timestamp)))
  card.append(meta, el('p', '', message.text))
  for (const link of message.links) {
    const anchor = document.createElement('a')
    anchor.href = link.url
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
    anchor.textContent = link.title || link.url
    card.append(anchor)
  }
  return card
}

async function getJson<T>(url: string, cache: RequestCache): Promise<T> {
  const response = await fetch(url, { cache })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<T>
}

function secureLinks(root: HTMLElement) {
  for (const anchor of root.querySelectorAll('a')) {
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
  }
}

function formatRange(from: number, to: number) {
  if (new Date(from).toDateString() === new Date(to).toDateString()) {
    return `${formatTime(from)} – ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(to)}`
  }
  return `${formatTime(from)} – ${formatTime(to)}`
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function escapeHtml(source: string) {
  return source.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

