import { readFile } from 'node:fs/promises'
import { ChangeSet, MAX_EVIDENCE_MESSAGES, StoredMessage, Topic } from './model'

export interface AgentConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxSteps: number
  maxTokens: number
  maxInputChars: number
  timeout: number
}

export interface AgentTools {
  getRecentTopics(): Promise<Topic[]>
  getTopicContext(id: string): Promise<{ topic: Topic, messages: StoredMessage[] }>
  commitChanges(changes: ChangeSet): Promise<void>
}

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string, arguments: string }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: unknown
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_recent_topics',
      description: '读取最近活跃的十个话题精简目录。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_topic_context',
      description: '展开最近话题中的一个，读取正文和相关消息。',
      parameters: {
        type: 'object',
        properties: { topic_id: { type: 'string' } },
        required: ['topic_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'commit_changes',
      description: '一次性提交本批全部话题变更。没有可见话题变化时也要提交空变更。',
      parameters: {
        type: 'object',
        properties: {
          upsert: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '更新已有话题时填写；新话题省略。' },
                title: { type: 'string' },
                summary: { type: 'string' },
                body: { type: 'string', description: 'Markdown 正文，不得包含原始 HTML；在关键结论后用 {{evidence:消息ID}} 插入依据。' },
                messageIds: { type: 'array', items: { type: 'string' } },
                evidenceIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_EVIDENCE_MESSAGES },
                sourceMessageId: { type: 'string' },
              },
              required: ['title', 'summary', 'body', 'messageIds', 'evidenceIds'],
              additionalProperties: false,
            },
          },
          remove: { type: 'array', items: { type: 'string' } },
        },
        required: ['upsert', 'remove'],
        additionalProperties: false,
      },
    },
  },
]

const systemPrompt = `你是群聊补课 Agent。根据新消息持续维护有独立补课价值的话题。

规则：
- 初始消息已包含最近话题目录；只有确实需要时才展开单个话题。
- 相似主题若时间相隔很远，应创建新话题，不要强行延续旧话题。
- 一条消息最多属于一个话题；闲聊和噪声可以不进入任何话题。
- 正文结构由内容决定，使用简洁 Markdown，禁止原始 HTML。
- 新闻、链接、图片或原消息若引发讨论，应作为 sourceMessageId。
- 重要陈述后用 {{evidence:消息ID}} 放置依据，最多使用 ${MAX_EVIDENCE_MESSAGES} 条 evidenceIds，依据必须属于该话题。
- 最后必须恰好调用一次 commit_changes；不要输出给用户看的聊天回复。`

export async function runAgent(
  config: AgentConfig,
  batch: StoredMessage[],
  agentTools: AgentTools,
  request: typeof fetch = fetch,
  previousMessages: StoredMessage[] = [],
) {
  const recentTopics = (await agentTools.getRecentTopics()).map(topic => ({
    id: topic.id,
    title: topic.title,
    summary: topic.summary,
    updatedAt: topic.updatedAt,
  }))
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: await batchContent(batch, previousMessages, recentTopics) },
  ]

  for (let step = 0; step < config.maxSteps; step++) {
    const body = JSON.stringify({ model: config.model, messages, tools, tool_choice: 'auto', max_tokens: config.maxTokens })
    if (body.length > config.maxInputChars) throw new Error('Agent 输入超过成本上限。')
    const response = await request(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(config.timeout),
    })
    if (!response.ok) throw new Error(`模型请求失败：${response.status} ${(await response.text()).slice(0, 300)}`)
    const message = (await response.json() as any).choices?.[0]?.message as ChatMessage | undefined
    if (!message?.tool_calls?.length) throw new Error('Agent 未调用工具。')
    messages.push(message)

    for (const call of message.tool_calls) {
      const args = JSON.parse(call.function.arguments || '{}')
      let result: unknown
      if (call.function.name === 'get_recent_topics') {
        result = (await agentTools.getRecentTopics()).map(topic => ({
          id: topic.id,
          title: topic.title,
          summary: topic.summary,
          updatedAt: topic.updatedAt,
        }))
      } else if (call.function.name === 'get_topic_context') {
        result = await agentTools.getTopicContext(requireString(args.topic_id, 'topic_id'))
      } else if (call.function.name === 'commit_changes') {
        await agentTools.commitChanges(parseChangeSet(args))
        return
      } else {
        throw new Error(`未知工具：${call.function.name}`)
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
    }
  }
  throw new Error('Agent 达到最大步骤数且未提交。')
}

async function batchContent(batch: StoredMessage[], previousMessages: StoredMessage[], recentTopics: Array<Pick<Topic, 'id' | 'title' | 'summary' | 'updatedAt'>>) {
  const content: any[] = [{
    type: 'text',
    text: [
      previousMessages.length
        ? `这是本批之前的相邻消息，仅用于判断讨论是否延续，不要将其 ID 加入变更集：\n${JSON.stringify(previousMessages.map(publicMessage))}`
        : '',
      `这是最近活跃的十个话题目录：\n${JSON.stringify(recentTopics)}`,
      `这是本批新消息。时间为 Unix 毫秒，消息 ID 必须原样用于变更集：\n${JSON.stringify(batch.map(publicMessage))}`,
    ].filter(Boolean).join('\n\n'),
  }]
  const images = batch.flatMap(message => message.images.map(image => ({ message, image })))
    .filter(({ image }) => image.localPath && image.mediaType?.startsWith('image/'))
    .slice(0, 6)
  for (const { message, image } of images) {
    const data = await readFile(image.localPath!)
    content.push({ type: 'text', text: `消息 ${message.id} 的图片：` })
    content.push({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${data.toString('base64')}` } })
  }
  return content
}

function publicMessage(message: StoredMessage) {
  return {
    id: message.id,
    timestamp: message.timestamp,
    author: message.author.name,
    text: message.text,
    links: message.links,
    imageCount: message.images.length,
  }
}

function parseChangeSet(value: any): ChangeSet {
  if (!value || !Array.isArray(value.upsert) || !Array.isArray(value.remove)) throw new Error('变更集格式错误。')
  const upsert = value.upsert.map((topic: any) => {
    if (!topic || !Array.isArray(topic.messageIds) || !Array.isArray(topic.evidenceIds)) throw new Error('话题格式错误。')
    return {
      id: optionalString(topic.id, 'id'),
      title: requireString(topic.title, 'title'),
      summary: requireString(topic.summary, 'summary'),
      body: requireString(topic.body, 'body'),
      messageIds: topic.messageIds.map((id: unknown) => requireString(id, 'messageIds')),
      evidenceIds: topic.evidenceIds.map((id: unknown) => requireString(id, 'evidenceIds')),
      sourceMessageId: optionalString(topic.sourceMessageId, 'sourceMessageId'),
    }
  })
  return { upsert, remove: value.remove.map((id: unknown) => requireString(id, 'remove')) }
}

function requireString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必须是非空字符串。`)
  return value
}

function optionalString(value: unknown, field: string) {
  return value === undefined ? undefined : requireString(value, field)
}
