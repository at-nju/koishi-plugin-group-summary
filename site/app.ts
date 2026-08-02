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
  const details = createElement('details', 'topic group overflow-hidden rounded-2xl border border-line bg-card shadow-[0_1px_2px_rgba(43,41,35,0.04),0_8px_24px_rgba(43,41,35,0.06)] transition-shadow hover:shadow-[0_2px_4px_rgba(43,41,35,0.06),0_12px_32px_rgba(43,41,35,0.10)]')
  const heading = createElement('summary', 'topic-heading flex cursor-pointer select-none items-start justify-between gap-4 p-6 sm:p-7 [&::-webkit-details-marker]:hidden')
  const text = createElement('div', 'min-w-0')
  text.append(
    createElement('h2', 'topic-title font-display text-xl font-bold leading-snug sm:text-2xl', topic.title),
    createElement('p', 'topic-summary mt-2 text-sm leading-relaxed text-ink/55', topic.summary),
  )
  const meta = createElement('div', 'flex shrink-0 flex-col items-end gap-2 pt-1')
  meta.append(
    createElement('time', 'topic-time text-right text-xs leading-5 text-ink/40', formatRange(topic.activeFrom, topic.activeTo)),
    createElement('span', 'grid h-6 w-6 place-items-center rounded-full border border-line text-xs text-accent transition-transform duration-200 group-open:rotate-180', '▾'),
  )
  heading.append(text, meta)

  const body = createElement('div', 'topic-body border-t border-line px-6 pb-7 pt-2 sm:px-7')
  if (topic.source) body.append(messageCard(topic.source, '话题源'))
  appendMarkdown(body, topic.body.replace(/\{\{evidence:[^}]+\}\}/g, ''))
  details.append(heading, body)
  return details
}

function appendMarkdown(parent: HTMLElement, source: string) {
  if (!source.trim()) return
  const markdown = createElement('div', 'markdown mt-3')
  markdown.innerHTML = DOMPurify.sanitize(String(marked.parse(source)))
  secureLinks(markdown)
  parent.append(markdown)
}

function messageCard(message: PublishedMessage, label?: string) {
  const card = createElement('blockquote', 'message my-4 rounded-r-lg border-l-4 border-accent/60 bg-accent/5 px-4 py-3')
  if (label) card.append(createElement('strong', 'message-label mb-2 block text-[11px] font-bold uppercase tracking-widest text-accent', label))
  const meta = createElement('div', 'message-meta flex items-center gap-2 text-xs text-ink/50')
  if (message.author.avatar) {
    const avatar = document.createElement('img')
    avatar.src = message.author.avatar
    avatar.alt = ''
    avatar.loading = 'lazy'
    avatar.className = 'h-5 w-5 rounded-full object-cover'
    meta.append(avatar)
  }
  meta.append(createElement('span', '', message.author.name), createElement('time', '', formatTime(message.timestamp)))
  card.append(meta, createElement('p', 'mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink/80', message.text))
  for (const link of message.links) {
    const anchor = document.createElement('a')
    anchor.href = link.url
    anchor.className = 'mt-1 block text-sm text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent'
    anchor.textContent = link.title || link.url
    secureLink(anchor)
    card.append(anchor)
  }
  return card
}

async function getJson<T>(url: string, cache: RequestCache): Promise<T> {
  const response = await fetch(url, { cache })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<T>
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

function secureLinks(root: HTMLElement) {
  root.querySelectorAll('a').forEach(secureLink)
}

function secureLink(anchor: HTMLAnchorElement) {
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
}
