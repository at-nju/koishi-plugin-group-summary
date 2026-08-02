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
    body: z.string().min(1).describe('总结为主的 Markdown 正文；结尾含「相关人员」小节，不引用原始消息。'),
    messageIds: z.array(z.string().min(1)).min(1),
    sourceMessageId: optionalId,
  })),
  remove: z.array(z.string().min(1)),
})

const instructions = `你是群聊话题总结 Agent，为群聊维护可独立阅读的话题总结。

每个话题包含标题、一两句话的摘要和完整的总结正文；正文结尾写「相关人员」小节，用 @名字 列出主要参与者，可注明角色或立场。

规则：
- 话题要大：同一件事的零散讨论合并成一个话题；相似主题相隔很久再次出现时才开新话题。
- 一条消息最多属于一个话题；闲聊和噪声可以不进任何话题。
- 正文用连贯段落叙述起因、经过、各方观点、共识或结论、后续安排，不引用原始消息；总结可以长一些，但读者只看正文就能读懂。
- 新消息和最近话题目录已在上下文中，只有需要详情时才展开单个话题。
- 由新闻、链接或图片引发的讨论，把原始消息设为话题源。
- 正文使用简洁 Markdown。
- 最后恰好调用一次 commit_changes，不要输出聊天回复。`

export async function runAgent(
  config: AgentConfig,
  batch: StoredMessage[],
  agentTools: AgentTools,
  previousMessages: StoredMessage[] = [],
): Promise<boolean> {
  const recentTopics = await agentTools.getRecentTopics()
  let committed = false
  const agent = new ToolLoopAgent({
    model: createOpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey }).chat(config.model),
    instructions,
    maxOutputTokens: 8192,
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

  const content = await batchContent(batch, previousMessages, recentTopics)
  const attempt = async (hint?: string) => {
    await agent.generate({
      messages: [
        ...(hint ? [{ role: 'user' as const, content: hint }] : []),
        { role: 'user', content },
      ],
      timeout: 5 * 60_000,
    })
    return committed
  }

  if (await attempt()) return true
  if (await attempt('上次尝试没有在步骤上限内提交变更。这次请直接调用 commit_changes 完成提交；没有可见话题变化时也要提交空变更集，不要重复展开话题。')) return true
  await agentTools.commitChanges({ upsert: [], remove: [] })
  return false
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
