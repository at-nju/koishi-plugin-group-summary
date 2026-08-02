import { Context, Schema, Session, Time, Universal } from 'koishi'
import { resolve } from 'node:path'
import { AgentConfig, runAgent } from './agent'
import { normalizeMessage } from './content'
import { enrichMessage } from './enrich'
import { R2Config, buildSnapshot, publishSnapshot } from './publish'
import {
  commitChanges,
  ensureInitialPublish,
  getAllTopics,
  getExistingMessageIds,
  getMessages,
  getPendingMessages,
  getPreviousMessages,
  getRecentTopics,
  isPublishPending,
  markPublished,
  registerModels,
  saveMessages,
} from './storage'

export const name = 'group-summary'
export const inject = { required: ['database'] }

export interface Config {
  target: {
    platform: string
    channelId: string
  }
  model: AgentConfig
  r2: R2Config
  batchInterval: number
  historyInterval: number
  maxBatchMessages: number
  dataDir: string
}

export const Config: Schema<Config> = Schema.object({
  target: Schema.object({
    platform: Schema.string().default('onebot').description('目标群使用的平台。'),
    channelId: Schema.string().required().description('唯一目标群的频道 ID。'),
  }).description('目标群'),
  model: Schema.object({
    baseUrl: Schema.string().default('https://api.openai.com/v1').description('OpenAI 兼容接口地址。'),
    apiKey: Schema.string().role('secret').required().description('模型接口密钥。'),
    model: Schema.string().required().description('支持图文输入和工具调用的模型。'),
    maxSteps: Schema.natural().min(2).max(20).default(6).description('每批 Agent 最大步骤数。'),
    maxTokens: Schema.natural().min(256).max(16_384).default(4096).description('每次模型请求最多生成的 token 数。'),
    timeout: Schema.natural().role('ms').default(Time.minute).description('单次模型请求超时。'),
  }).description('总结模型'),
  r2: Schema.object({
    accountId: Schema.string().required().description('Cloudflare Account ID。'),
    bucket: Schema.string().default('group-summary').description('R2 bucket 名称。'),
    accessKeyId: Schema.string().role('secret').required().description('R2 API token Access Key ID。'),
    secretAccessKey: Schema.string().role('secret').required().description('R2 API token Secret Access Key。'),
    prefix: Schema.string().default('group-summary').description('R2 对象前缀。'),
  }).description('发布目标'),
  batchInterval: Schema.natural().role('ms').min(Time.minute).default(10 * Time.minute).description('总结与发布检查间隔。'),
  historyInterval: Schema.natural().role('ms').min(Time.minute).default(5 * Time.minute).description('历史补采间隔。'),
  maxBatchMessages: Schema.natural().min(1).max(500).default(100).description('单批最多处理的消息数。'),
  dataDir: Schema.string().default('data/group-summary').description('本地图片保存目录。'),
}) as Schema<Config>

export function apply(ctx: Context, config: Config) {
  registerModels(ctx)
  const logger = ctx.logger(name)
  const dataDir = resolve(process.cwd(), config.dataDir)
  let ingestion = Promise.resolve()

  // ponytail: one serial chain is enough for one target group; use a durable queue only if multi-group throughput is added.
  const ingest = (messages: Array<{ platform: string, channelId: string, message: Universal.Message }>) => {
    ingestion = ingestion.then(async () => {
      const normalized = messages.flatMap(({ platform, channelId, message }) => {
        const item = normalizeMessage(platform, channelId, message)
        return item ? [item] : []
      })
      const existing = await getExistingMessageIds(ctx, normalized.map(message => message.id))
      const fresh = normalized.filter(message => !existing.has(message.id))
      const enriched = await Promise.all(fresh.map(message => enrichMessage(message, dataDir)))
      const count = await saveMessages(ctx, enriched)
      if (count) logger.debug('采集 %d 条新消息。', count)
    }).catch(error => logger.warn('消息采集失败：%s', formatError(error)))
    return ingestion
  }

  const reconcileHistory = async () => {
    const bot = ctx.bots.find(bot => bot.platform === config.target.platform)
    if (!bot) {
      logger.warn('未找到平台 %s 的机器人，暂不补采历史。', config.target.platform)
      return
    }
    try {
      const { data } = await bot.getMessageList(config.target.channelId)
      await ingest(data.map(message => ({ platform: config.target.platform, channelId: config.target.channelId, message })))
    } catch (error) {
      logger.warn('历史补采失败：%s', formatError(error))
    }
  }

  const publish = async () => {
    if (!await isPublishPending(ctx)) return
    const topics = await getAllTopics(ctx)
    const messageIds = [...new Set(topics.flatMap(topic => topic.messageIds))]
    const snapshot = buildSnapshot(topics, await getMessages(ctx, messageIds))
    await publishSnapshot(config.r2, snapshot)
    await markPublished(ctx, new Date(snapshot.generatedAt))
    logger.info('已发布 %d 个话题，版本 %s。', snapshot.topics.length, snapshot.version)
  }

  const runCycle = skipWhileRunning(async () => {
    try {
      await ingestion
      const batch = await getPendingMessages(ctx, config.maxBatchMessages)
      if (batch.length) {
        const previousMessages = await getPreviousMessages(ctx, batch[0].timestamp)
        const recent = await getRecentTopics(ctx)
        const recentById = new Map(recent.map(topic => [topic.id, topic]))
        await runAgent(config.model, batch, {
          getRecentTopics: async () => recent,
          getTopicContext: async (id) => {
            const topic = recentById.get(id)
            if (!topic) throw new Error(`不允许展开非最近话题：${id}`)
            return { topic, messages: await getMessages(ctx, topic.messageIds) }
          },
          commitChanges: changes => commitChanges(ctx, changes, batch.map(message => message.id)),
        }, fetch, previousMessages)
      }
    } catch (error) {
      logger.warn('总结批次失败：%s', formatError(error))
    }
    try {
      await publish()
    } catch (error) {
      logger.warn('发布失败，将保留旧版本并重试：%s', formatError(error))
    }
  })

  ctx.on('message', (session) => {
    if (!isTarget(session, config) || !session.event.message) return
    void ingest([{ platform: session.platform, channelId: session.channelId!, message: session.event.message }])
  })
  ctx.on('ready', async () => {
    await ensureInitialPublish(ctx)
    await reconcileHistory()
    await runCycle()
  })
  ctx.setInterval(reconcileHistory, config.historyInterval)
  ctx.setInterval(runCycle, config.batchInterval)
}

function isTarget(session: Session, config: Config) {
  return session.platform === config.target.platform && session.channelId === config.target.channelId
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function skipWhileRunning(task: () => Promise<void>) {
  let running = false
  return async () => {
    if (running) return
    running = true
    try {
      await task()
    } finally {
      running = false
    }
  }
}
