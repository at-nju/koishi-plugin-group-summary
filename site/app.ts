import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { PublishedSnapshot, PublishedTopic } from '../src/publish'

marked.use({
  gfm: true,
  breaks: true,
  renderer: { html: ({ text }) => escapeHtml(text) },
})

const status = document.querySelector<HTMLParagraphElement>('#status')!
const topics = document.querySelector<HTMLElement>('#topics')!
const filters = document.querySelector<HTMLElement>('#filters')!
const moreButton = document.querySelector<HTMLButtonElement>('#more')!
const themeToggle = document.querySelector<HTMLButtonElement>('#theme-toggle')!
const dataUrl = document.querySelector<HTMLMetaElement>('meta[name="group-summary-data"]')!.content.replace(/\/$/, '')
const pageSize = 20
let snapshot: PublishedSnapshot
let shown = 0
let activeTag: string | null = null

themeToggle.addEventListener('click', () => {
  const dark = document.documentElement.classList.toggle('dark')
  localStorage.setItem('theme', dark ? 'dark' : 'light')
})

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
  renderFilters()
  renderNext()
}

function renderNext() {
  const list = visibleTopics()
  const next = list.slice(shown, shown + pageSize)
  topics.append(...next.map(topicCard))
  shown += next.length
  moreButton.hidden = shown >= list.length
}

function visibleTopics() {
  const tag = activeTag
  return tag ? snapshot.topics.filter(topic => topicTags(topic).includes(tag)) : snapshot.topics
}

function renderFilters() {
  const counts = new Map<string, number>()
  for (const topic of snapshot.topics) {
    for (const tag of topicTags(topic)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag)
  if (!tags.length) return
  filters.hidden = false
  for (const tag of tags) {
    const button = createElement('button', 'filter-chip rounded-full border border-line bg-card px-3 py-1 text-xs text-ink/60 transition-colors hover:border-accent/50 hover:text-accent')
    button.type = 'button'
    button.textContent = tag
    button.addEventListener('click', () => {
      activeTag = activeTag === tag ? null : tag
      for (const chip of filters.querySelectorAll('button')) {
        chip.classList.toggle('filter-chip--active', chip.textContent === activeTag)
      }
      topics.replaceChildren()
      shown = 0
      renderNext()
    })
    filters.append(button)
  }
}

function topicCard(topic: PublishedTopic) {
  const details = createElement('details', 'topic group overflow-hidden rounded-2xl border border-line bg-card shadow-sm transition-shadow hover:shadow-md')
  const heading = createElement('summary', 'topic-heading flex cursor-pointer select-none flex-col gap-2 p-6 [&::-webkit-details-marker]:hidden')
  const row = createElement('div', 'flex items-baseline justify-between gap-1 flex-col sm:flex-row')
  row.append(
    createElement('h2', 'topic-title min-w-0 text-xl font-bold leading-snug', topic.title),
    createElement('time', 'topic-time shrink-0 text-xs leading-5 text-ink/40', formatRange(topic.activeFrom, topic.activeTo)),
  )
  heading.append(row, createElement('p', 'topic-summary text-sm leading-relaxed text-ink/55', topic.summary))
  const tags = topicTags(topic)
  if (tags.length) {
    const tagsRow = createElement('div', 'flex flex-wrap gap-1.5')
    for (const tag of tags) {
      tagsRow.append(createElement('span', 'tag-badge rounded-full border border-line bg-paper px-2 py-0.5 text-[11px] text-ink/60', tag))
    }
    heading.append(tagsRow)
  }

  const body = createElement('div', 'topic-body border-t border-line px-6 pb-7 pt-2')
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

function topicTags(topic: PublishedTopic) {
  return Array.isArray(topic.tags) ? topic.tags : []
}

async function getJson<T>(url: string, cache: RequestCache): Promise<T> {
  const response = await fetch(url, { cache })
  const type = response.headers.get('content-type') ?? ''
  if (!response.ok || !type.includes('json')) {
    throw new Error(`HTTP ${response.status}（${type}）`)
  }
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
