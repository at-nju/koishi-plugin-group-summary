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
const moreButton = document.querySelector<HTMLButtonElement>('#more')!
const dataUrl = document.querySelector<HTMLMetaElement>('meta[name="group-summary-data"]')!.content.replace(/\/$/, '')
const pageSize = 20
let snapshot: PublishedSnapshot
let shown = 0

export const loadPromise = load().catch(error => {
  status.textContent = `加载失败：${error instanceof Error ? error.message : String(error)}`
})

moreButton.addEventListener('click', renderNext)

async function load() {
  const pointer = await getJson<{ snapshot: string }>(`${dataUrl}/latest.json`, 'no-store')
  snapshot = await getJson<PublishedSnapshot>(`${dataUrl}/${pointer.snapshot}`, 'force-cache')
  status.textContent = snapshot.topics.length
    ? `更新于 ${formatTime(snapshot.generatedAt)}`
    : '暂时还没有形成可见话题。'
  renderNext()
}

function renderNext() {
  const next = snapshot.topics.slice(shown, shown + pageSize)
  topics.append(...next.map(topicCard))
  shown += next.length
  moreButton.hidden = shown >= snapshot.topics.length
}

function topicCard(topic: PublishedTopic) {
  const details = createElement('details', 'topic')
  const heading = createElement('summary', 'topic-heading')
  const title = createElement('span', 'topic-title', topic.title)
  const summary = createElement('span', 'topic-summary', topic.summary)
  const time = createElement('time', 'topic-time', formatRange(topic.activeFrom, topic.activeTo))
  heading.append(title, summary, time)

  const body = createElement('div', 'topic-body')
  if (topic.source) body.append(messageCard(topic.source, '话题源'))
  const evidenceById = new Map(topic.evidence.map(message => [message.id, message]))
  const usedEvidence = new Set<string>()
  const marker = /\{\{evidence:([^}]+)\}\}/g
  let start = 0
  for (const match of topic.body.matchAll(marker)) {
    appendMarkdown(body, topic.body.slice(start, match.index))
    const evidence = evidenceById.get(match[1])
    if (evidence && !usedEvidence.has(evidence.id)) {
      body.append(messageCard(evidence, '依据'))
      usedEvidence.add(evidence.id)
    }
    start = match.index! + match[0].length
  }
  appendMarkdown(body, topic.body.slice(start))

  const remainingEvidence = topic.evidence.filter(message => !usedEvidence.has(message.id))
  if (remainingEvidence.length) {
    const evidence = createElement('section', 'evidence')
    evidence.append(createElement('h2', '', '依据消息'), ...remainingEvidence.map(message => messageCard(message)))
    body.append(evidence)
  }
  details.append(heading, body)
  return details
}

function appendMarkdown(parent: HTMLElement, source: string) {
  if (!source.trim()) return
  const markdown = createElement('div', 'markdown')
  markdown.innerHTML = DOMPurify.sanitize(String(marked.parse(source)))
  secureLinks(markdown)
  parent.append(markdown)
}

function messageCard(message: PublishedMessage, label?: string) {
  const card = createElement('blockquote', 'message')
  if (label) card.append(createElement('strong', 'message-label', label))
  const meta = createElement('div', 'message-meta')
  if (message.author.avatar) {
    const avatar = document.createElement('img')
    avatar.src = message.author.avatar
    avatar.alt = ''
    avatar.loading = 'lazy'
    meta.append(avatar)
  }
  meta.append(createElement('span', '', message.author.name), createElement('time', '', formatTime(message.timestamp)))
  card.append(meta, createElement('p', '', message.text))
  for (const link of message.links) {
    const anchor = document.createElement('a')
    anchor.href = link.url
    secureLink(anchor)
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
  root.querySelectorAll('a').forEach(secureLink)
}

function secureLink(anchor: HTMLAnchorElement) {
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
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

function createElement<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function escapeHtml(source: string) {
  return source.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}
