import { createOpenAI } from '@ai-sdk/openai'
import { hasToolCall, stepCountIs, tool, ToolLoopAgent } from 'ai'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { ChangeSet, StoredMessage, Topic } from './model'

export interface AgentConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export interface AgentTools {
  getRecentTopics(): Promise<Topic[]>
  getTopicContext(id: string): Promise<{ topic: Topic, messages: StoredMessage[] }>
  commitChanges(changes: ChangeSet): Promise<void>
}

const optionalId = z.string().min(1).nullish().transform(value => value ?? undefined)
const changeSetSchema = z.object({
  upsert: z.array(z.object({
    id: optionalId.describe('更新已有话题时填写；新话题省略。'),
    title: z.string().min(1),
    summary: z.string().min(1).describe('一两句话的话题摘要。'),
    body: z.string().min(1).describe('总结为主的 Markdown 正文；结尾含「相关人员」小节，不要内嵌 {{evidence}} 引用。'),
    messageIds: z.array(z.string().min(1)).min(1),
    sourceMessageId: optionalId,
  })),
  remove: z.array(z.string().min(1)),
})

const instructions = `你是群聊补课 Agent。根据新消息持续维护有独立补课价值的话题。

规则：
- 初始消息已包含最近话题目录；只有确实需要时才展开单个话题。
- 话题要大：围绕同一件事的零散讨论应合并成一个完整话题，不要拆成细碎的小话题；相似主题若时间相隔很远，再创建新话题。
- 一条消息最多属于一个话题；闲聊和噪声可以不进入任何话题。
- 正文结构由内容决定，使用简洁 Markdown，禁止原始 HTML。
- 正文以总结为主，用连贯的段落叙述整个讨论：起因、关键经过、各方观点、共识或结论、后续安排。总结可以长一些，但必须完整自洽，读者不依赖原始消息也能读懂；不要在正文中引用或转述大段原话。
- 正文结尾写一个「相关人员」小节，用 @名字 列出主要参与者，可简要注明各自角色或立场。
- 新闻、链接、图片或原消息若引发讨论，应作为 sourceMessageId。
- 必须原样保留的关键原话（如公告、投票结果）可以直接写进正文，不要在正文中内嵌 {{evidence}} 引用。
- 最后必须恰好调用一次 commit_changes；不要输出给用户看的聊天回复。`

export async function runAgent(
  config: AgentConfig,
  batch: StoredMessage[],
  agentTools: AgentTools,
  previousMessages: StoredMessage[] = [],
) {
  const recentTopics = await agentTools.getRecentTopics()
  let committed = false
  const agent = new ToolLoopAgent({
    model: createOpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey }).chat(config.model),
    instructions,
    maxOutputTokens: 4096,
    stopWhen: [hasToolCall('commit_changes'), stepCountIs(6)],
    tools: {
      get_recent_topics: tool({
        description: '读取最近活跃的十个话题精简目录。',
        inputSchema: z.object({}),
        execute: async () => topicDirectory(await agentTools.getRecentTopics()),
      }),
      get_topic_context: tool({
        description: '展开最近话题中的一个，读取正文和相关消息。',
        inputSchema: z.object({ topic_id: z.string().min(1) }),
        execute: async ({ topic_id }) => agentTools.getTopicContext(topic_id),
      }),
      commit_changes: tool({
        description: '一次性提交本批全部话题变更。没有可见话题变化时也要提交空变更。',
        inputSchema: changeSetSchema,
        execute: async (changes) => {
          if (committed) throw new Error('commit_changes 只能调用一次。')
          await agentTools.commitChanges(changes)
          committed = true
          return { committed: true }
        },
      }),
    },
  })

  await agent.generate({
    messages: [{ role: 'user', content: await batchContent(batch, previousMessages, recentTopics) }],
    timeout: 5 * 60_000,
  })
  if (!committed) throw new Error('Agent 未提交变更。')
}

function topicDirectory(topics: Topic[]) {
  return topics.map(({ id, title, summary, updatedAt }) => ({ id, title, summary, updatedAt }))
}

async function batchContent(batch: StoredMessage[], previousMessages: StoredMessage[], recentTopics: Topic[]) {
  const content: Array<
    { type: 'text', text: string }
    | { type: 'file', data: Buffer, mediaType: string }
  > = [{
    type: 'text',
    text: [
      previousMessages.length
        ? `这是本批之前的相邻消息，仅用于判断讨论是否延续，不要将其 ID 加入变更集：\n${JSON.stringify(previousMessages.map(publicMessage))}`
        : '',
      `这是最近活跃的十个话题目录：\n${JSON.stringify(topicDirectory(recentTopics))}`,
      `这是本批新消息。时间为 Unix 毫秒，消息 ID 必须原样用于变更集：\n${JSON.stringify(batch.map(publicMessage))}`,
    ].filter(Boolean).join('\n\n'),
  }]
  const images = batch.flatMap(message => message.images.map(image => ({ message, image })))
    .filter(({ image }) => image.localPath && image.mediaType?.startsWith('image/'))
    .slice(0, 6)
  for (const { message, image } of images) {
    content.push({ type: 'text', text: `消息 ${message.id} 的图片：` })
    content.push({ type: 'file', data: await readFile(image.localPath!), mediaType: image.mediaType! })
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
