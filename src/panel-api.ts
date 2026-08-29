/**
 * dsh-zotero — panel bridge API (host half).
 *
 * Routes under /@dsh-external/dsh-zotero/api used by the browser half (M3):
 *   GET  /status             connection health (M1)
 *   GET  /verify             health + search sample + collections roots
 *   GET  /tree               collections (flat) + recent items
 *   GET  /item?key=          item detail (children included)
 *   GET  /read?itemKey=      parse → cache (pdftotext/MinerU) + preview
 *   GET  /summarize?itemKey= LLM overview/targeted summary (DSH model)
 *   POST /inject-context     push paper context into the current conversation
 *   GET  /config             plugin config snapshot (secrets masked)
 *   GET/POST /artifacts      产出物区（库内 JSON 持久化）
 * M3.2 文献聊天（独立浮动窗口 + 每篇论文一个会话 + History）：
 *   GET  /chat-sessions     History（论文会话 + 文献库会话）
 *   POST /chat-open         打开/复用论文会话（注入全文，可选发精读指令）
 *   POST /chat-open-library 打开/复用文献库会话（注入库级引导）
 *   POST /chat-send         发消息（冷会话自动恢复）
 *   GET  /chat-messages     文献会话消息缓存（host session/event 订阅累积）
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type LlmService from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ZoteroClient } from './zotero/client.ts'
import type { Config as ZoteroConfig } from './config.ts'
import type { ResolvedModel } from './ml.ts'
import { ensureParsed, runSummary } from './tools-m2.ts'
import { resolveCacheDir } from './mineru/cache.ts'
import { composeConfig, currentConfig, setActiveConfig, writeOverlay } from './runtime.ts'

export const PLUGIN_ID = '@dsh-external/dsh-zotero'
export const API_PREFIX = '/@dsh-external/dsh-zotero/api'

const READ_PROMPT =
  '「Zotero 开读」——请以精读模式阅读上面注入的论文：先一句话概述核心贡献，再按章节提炼要点（方法/关键结果/局限），最后给 3 个可深入追问的问题。信息不足时调用 zotero_read_pdf / zotero_summarize 补充阅读。'

const LIBRARY_MODE_PROMPT =
  '你是 Zotero 文献库精读助手。用户会问本库文献的问题：先用 zotero_library_search（支持全文 qmode=everything）找到相关论文，再用 zotero_read_pdf / zotero_summarize(zotero_translate) 深读，最后给出结构化回答（引用具体论文标题/年份/关键数字）。一次不要读取超过 2 篇全文，保持回答有据可查。'

const SECRET_FIELDS = new Set(['localApiKey', 'webApiKey', 'mineruCloudApiKey'])

/* ── 文献聊天（M3.2 rev2）：每篇论文一个会话 + History 列表 ────────────
 * 会话 id 确定性（zotero-paper-<itemKey> / zotero-library），映射持久化
 * 在 chat-sessions.json；消息缓存仍由 host session/event 订阅累积。
 * 参考同环境已装配的 dsh-better-sidebar（ctx.get('agents') + create/resume）。
 */

interface ChatPaperEntry {
  itemKey: string
  title: string
  sessionId: string
  injectedAt: number
  at: number
}

interface ChatLibraryEntry {
  sessionId: string
  injectedAt: number
  at: number
}

interface ChatSessionStore {
  papers: ChatPaperEntry[]
  library?: ChatLibraryEntry
}

const LIBRARY_SESSION_ID = 'zotero-library'

function chatStorePath(): string {
  return join(resolveCacheDir(currentConfig()), 'chat-sessions.json')
}

function readChatStore(): ChatSessionStore {
  try {
    const p = chatStorePath()
    if (!existsSync(p)) return { papers: [] }
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<ChatSessionStore>
    return {
      papers: Array.isArray(raw.papers)
        ? raw.papers.filter((x): x is ChatPaperEntry => Boolean(x && typeof x.sessionId === 'string' && typeof x.itemKey === 'string'))
        : [],
      ...(raw.library && typeof raw.library.sessionId === 'string' ? { library: raw.library } : {}),
    }
  } catch {
    return { papers: [] }
  }
}

function writeChatStore(store: ChatSessionStore): void {
  try {
    mkdirSync(dirname(chatStorePath()), { recursive: true })
    writeFileSync(chatStorePath(), JSON.stringify(store, null, 2), 'utf8')
  } catch { /* best-effort */ }
}

/** 文献会话消息缓存（host session/event 订阅写入；面板轮询读取）。 */
export interface ChatLogMsg {
  kind: 'user' | 'assistant' | 'tool'
  text: string
  name?: string
  running?: boolean
  ok?: boolean
  at: number
}
const chatLogs = new Map<string, ChatLogMsg[]>()

export function pushChatLog(sessionId: string, msg: ChatLogMsg): void {
  const list = chatLogs.get(sessionId) ?? []
  const last = list[list.length - 1]
  // assistant 流式累积：chunk 追加到 running 尾部；完整 message 替换该 running 条。
  if (msg.kind === 'assistant' && msg.running && last?.kind === 'assistant' && last.running) {
    last.text += msg.text
    last.at = msg.at
    chatLogs.set(sessionId, list)
    return
  }
  if (msg.kind === 'assistant' && !msg.running && msg.text && last?.kind === 'assistant' && last.running) {
    last.text = msg.text
    last.running = false
    last.at = msg.at
    chatLogs.set(sessionId, list)
    return
  }
  // tool/result 落定：替换同名的 running 工具行（避免重复）。
  if (msg.kind === 'tool' && !msg.running && last?.kind === 'tool' && last.running && last.name === msg.name) {
    last.running = false
    last.ok = msg.ok
    last.at = msg.at
    chatLogs.set(sessionId, list)
    return
  }
  list.push(msg)
  if (list.length > 400) list.splice(0, list.length - 400)
  chatLogs.set(sessionId, list)
}

export function chatMessages(sessionId: string): ChatLogMsg[] {
  return chatLogs.get(sessionId) ?? []
}

/* ── agents 服务结构类型（不依赖 @deepseek-ai/dsh-agent 类型） ── */

interface AgentLike {
  inject(msg: unknown): void
  followup(msg: unknown): void
  cancel?(opts?: unknown): void
  session?: { header?: { cwd?: string }; id?: string }
}

interface AgentsLike {
  get(id: unknown): AgentLike | undefined
  create(opts: {
    sessionId: string
    meta?: { cwd?: string; parentSession?: string; origin?: 'subagent' }
    signal?: AbortSignal
  }): Promise<{ agent: AgentLike; dispose(): Promise<void> }>
  resume(opts: {
    resumeSessionId: string
    signal?: AbortSignal
  }): Promise<{ agent: AgentLike; dispose(): Promise<void> }>
}

function agentsOf(deps: PanelApiDeps): AgentsLike | undefined {
  return deps.agents as AgentsLike | undefined
}

/**
 * 激活（或恢复）一个文献会话：live 优先；否则 create（新 id）失败则
 * resume（已持久化、web 重启后的冷会话）。
 */
async function ensureLiveAgent(
  agents: AgentsLike,
  sessionId: string,
  cwd?: string,
): Promise<AgentLike> {
  const live = agents.get(sessionId)
  if (live) return live
  if (agents.create) {
    try {
      const handle = await agents.create({
        sessionId,
        ...(cwd ? { meta: { cwd } } : {}),
        signal: AbortSignal.timeout(20000),
      })
      return handle.agent
    } catch { /* id 已持久化或冲突 → 走 resume */ }
  }
  if (agents.resume) {
    try {
      const handle = await agents.resume({ resumeSessionId: sessionId, signal: AbortSignal.timeout(20000) })
      return handle.agent
    } catch (err: unknown) {
      throw new Error(`文献会话激活失败: ${String((err as Error)?.message ?? err)}`)
    }
  }
  throw new Error('agents 服务不可用（create/resume 均缺失）')
}

function injectText(agent: AgentLike, text: string): void {
  agent.inject({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_ID },
  })
}

function followupText(agent: AgentLike, text: string): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}

/** 从 body.parent（主会话 id）解析 cwd：live agent 直读，冷会话走 sessionPersistence.inspect。 */
async function parentCwdOf(deps: PanelApiDeps, body: Record<string, unknown>): Promise<string | undefined> {
  const parent = String(body.parent ?? '')
  if (!parent) return undefined
  try {
    const agent = agentsOf(deps)?.get(parent)
    const cwd = agent?.session?.header?.cwd
    if (cwd) return cwd
  } catch { /* fall through */ }
  try {
    const persistence = deps.sessionPersistence as
      | { inspect?(id: string): Promise<{ meta?: { cwd?: string } } | undefined> }
      | undefined
    const inspected = await persistence?.inspect?.(parent)
    if (inspected?.meta?.cwd) return inspected.meta.cwd
  } catch { /* fall through */ }
  return undefined
}

/** 打开（或复用）某论文的文献会话：注入全文（首次/force），可选送精读指令。 */
export async function openPaperChatSession(
  deps: PanelApiDeps,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; sessionId?: string; chars?: number; error?: string; cwd?: string }> {
  const agents = agentsOf(deps)
  if (!agents?.create && !agents?.resume) return { ok: false, error: 'agents 服务不可用' }
  const itemKey = String(body.itemKey ?? '')
  if (!itemKey) return { ok: false, error: '需要 itemKey' }
  const title = String(body.title ?? '') || itemKey
  const store = readChatStore()
  const entry = store.papers.find((p) => p.itemKey === itemKey)
  const sessionId = entry?.sessionId ?? `zotero-paper-${itemKey}`
  const cwd = String(body.cwd ?? '') || (await parentCwdOf(deps, body))
  console.log(`[dsh-zotero] chat-open itemKey=${itemKey} parent=${String(body.parent ?? '')} cwd=${JSON.stringify(cwd)} via=${body.cwd ? 'body' : 'parent'}`)

  let agent: AgentLike
  try {
    agent = await ensureLiveAgent(agents, sessionId, cwd)
  } catch (err: unknown) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }

  const alreadyInjected = Boolean(entry && entry.injectedAt > 0)
  let chars = 0
  if (!alreadyInjected || body.force) {
    const built = await buildPaperContext(deps, { ...body, itemKey })
    if (!built.ok) return { ok: false, sessionId, error: built.error ?? '构建论文上下文失败' }
    injectText(agent, built.text)
    chars = built.text.length
    writeChatStore({
      papers: [
        ...store.papers.filter((p) => p.itemKey !== itemKey),
        { itemKey, title, sessionId, injectedAt: Date.now(), at: Date.now() },
      ],
      ...(store.library ? { library: store.library } : {}),
    })
  }
  if (body.sendRead) followupText(agent, READ_PROMPT)
  // History 标题跟随最新打开时的标题（已存在会话也更新）。
  if (entry && body.title && body.title !== entry.title) {
    writeChatStore({
      papers: [
        ...store.papers.filter((p) => p.itemKey !== itemKey),
        { ...entry, title: String(body.title), at: Date.now() },
      ],
      ...(store.library ? { library: store.library } : {}),
    })
  }
  return { ok: true, sessionId, chars, cwd: cwd ?? '' }
}

/** 打开（或复用）「文献库对话」会话：注入库级引导（仅首次）。 */
export async function openLibraryChatSession(
  deps: PanelApiDeps,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; sessionId?: string; chars?: number; error?: string }> {
  const agents = agentsOf(deps)
  if (!agents?.create && !agents?.resume) return { ok: false, error: 'agents 服务不可用' }
  const cwd = String(body.cwd ?? '') || (await parentCwdOf(deps, body))
  const store = readChatStore()
  const entry = store.library
  const sessionId = entry?.sessionId ?? LIBRARY_SESSION_ID

  let agent: AgentLike
  try {
    agent = await ensureLiveAgent(agents, sessionId, cwd)
  } catch (err: unknown) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }

  let chars = 0
  if (!entry?.injectedAt || body.force) {
    injectText(agent, `【Zotero 文献库对话模式】\n${LIBRARY_MODE_PROMPT}`)
    chars = LIBRARY_MODE_PROMPT.length
    writeChatStore({
      papers: store.papers,
      library: { sessionId, injectedAt: Date.now(), at: Date.now() },
    })
  }
  if (body.sendIntro) {
    followupText(agent, '你好！请先简单介绍你能做什么，并给我 3 个可立即使用的示例问题。')
  }
  return { ok: true, sessionId, chars }
}

/** 向文献会话发送一条消息（冷会话自动恢复；@papers 逐个注入元数据/全文）。 */
export async function sendChatMessage(
  deps: PanelApiDeps,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; chars?: number; error?: string }> {
  const agents = agentsOf(deps)
  if (!agents) return { ok: false, error: 'agents 服务不可用' }
  const sessionId = String(body.sessionId ?? '')
  const text = String(body.text ?? '').trim()
  if (!sessionId || !text) return { ok: false, error: '需要 sessionId + text' }
  let agent: AgentLike
  try {
    agent = await ensureLiveAgent(agents, sessionId, String(body.cwd ?? '') || undefined)
  } catch (err: unknown) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
  try {
    // @论文 引用：发送前逐个注入（pdf=全文精读模式 qa；meta=元数据+摘要）。
    const papers = Array.isArray(body.papers) ? (body.papers as Array<Record<string, unknown>>) : []
    let chars = 0
    for (const p of papers.slice(0, 4)) {
      const itemKey = String(p?.itemKey ?? '')
      if (!itemKey) continue
      const mode = p.mode === 'pdf' ? 'qa' : 'meta'
      const built = await buildPaperContext(deps, { ...body, itemKey, mode })
      if (built.ok) {
        injectText(agent, built.text)
        chars += built.chars
      }
    }
    followupText(agent, text)
    return { ok: true, chars }
  } catch (err: unknown) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
}

/** 文献会话模型选择（sessionController.selectModel；跟随 GUI 语义）。 */
export async function selectChatModel(
  deps: PanelApiDeps,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const sc = deps.sessionController as
    | { selectModel?(req: Record<string, unknown>): Promise<{ selected: unknown }> }
    | undefined
  if (!sc?.selectModel) return { ok: false, error: '模型切换服务不可用（sessionController）' }
  try {
    await sc.selectModel({
      sessionId: String(body.sessionId ?? ''),
      provider: String(body.provider ?? ''),
      model: String(body.model ?? ''),
      ...(body.reasoningEffort ? { reasoningEffort: String(body.reasoningEffort) } : {}),
    })
    return { ok: true }
  } catch (err: unknown) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
}

/** 可用模型目录（provider → models）+ 当前选择。 */
export async function chatModels(deps: PanelApiDeps): Promise<{
  providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string; description?: string }> }>
  current: { provider: string; model: string; reasoningEffort?: string } | null
}> {
  let current: { provider: string; model: string; reasoningEffort?: string } | null = null
  try {
    const sel = deps.agentDefaultModel?.currentSelection()
    if (sel?.provider && sel?.model) {
      current = { provider: sel.provider, model: sel.model, ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}) }
    }
  } catch { /* ignore */ }
  const providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string; description?: string }> }> = []
  try {
    const llm = deps.llm as unknown as {
      listProviders?(): Array<{ id: string; name: string }>
      listModels?(provider: string): Promise<Array<{ id: string; name: string; description?: string }>>
    }
    const list = llm?.listProviders?.() ?? []
    // 并发 + 每 provider 5s 超时：单个 provider 挂起不再拖垮整个下拉。
    const withTimeout = <T>(p: Promise<T>): Promise<T | null> =>
      Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 5000))])
    const settled = await Promise.allSettled(list.map(async (p) => {
      let models: Array<{ id: string; name: string; description?: string }> = []
      try {
        const got = await withTimeout(llm.listModels?.(p.id) ?? Promise.resolve([]))
        models = (got ?? []).map((m) => ({ id: m.id, name: m.name, ...(m.description ? { description: m.description } : {}) }))
      } catch { /* provider 不可用则跳过模型 */ }
      return { id: p.id, name: p.name, models }
    }))
    for (const s of settled) {
      if (s.status === 'fulfilled') providers.push(s.value)
    }
  } catch { /* 目录失败返回空 */ }
  return { providers, current }
}

export interface PanelApiDeps {
  client: ZoteroClient
  llm: LlmService
  agentDefaultModel: { currentSelection(): ResolvedModel } | undefined
  /** Host agent service (optional) — used by /inject-context. */
  agents: unknown
  /** Host session persistence (optional) — 冷会话 cwd 解析（chat-open）。 */
  sessionPersistence?: unknown
  /** Host session controller (optional) — 文献会话模型选择（chat-select-model）。 */
  sessionController?: unknown
}

export interface PanelRouteHandler {
  (req: { url?: string; method?: string; body?: string; headers?: Record<string, string | string[] | undefined> }, res: { writeHead(status: number, headers: Record<string, string>): unknown; end(body: string): unknown }): Promise<void> | void
}

export function panelApiHandler(deps: PanelApiDeps): PanelRouteHandler {
  return (req, res) => void handle(req, res, deps)
}

async function handle(
  req: { url?: string; method?: string; body?: string; headers?: Record<string, string | string[] | undefined> },
  res: Res,
  deps: PanelApiDeps,
): Promise<void> {
  const [fullPath, queryString] = (req.url ?? '').split('?')
  const path = fullPath.startsWith(API_PREFIX) ? fullPath.slice(API_PREFIX.length) || '/' : fullPath
  const query = new URLSearchParams(queryString ?? '')
  const { client, llm, agentDefaultModel } = deps
  if (req.method === 'POST') {
    req.body = await readBody(req as never)
  }

  try {
    if (req.method === 'GET') {
      if (path === '/status') return send(res, 200, await healthOf(client))
      if (path === '/verify') return send(res, 200, await verifyOf(client))
      if (path === '/tree') return send(res, 200, await treeOf(client, query))
      if (path === '/item' && query.get('key')) return send(res, 200, await client.scoped().getItem(query.get('key')!))
      if (path === '/read' && query.get('itemKey')) return send(res, 200, await readOf(client, query))
      if (path === '/summarize' && query.get('itemKey')) {
        return send(res, 200, await runSummary(client, currentConfig(), llm, agentDefaultModel, {
          itemKey: query.get('itemKey')!,
          attachmentKey: query.get('attachmentKey') ?? undefined,
          mode: query.get('mode') ?? 'overview',
          query: query.get('query') ?? undefined,
        }, undefined).then((r) => {
          if (r.status === 'ok') appendArtifact(currentConfig(), { type: 'summary', title: r.title || query.get('itemKey')!, payload: r.summary.slice(0, 4000) })
          return r
        }))
      }
      if (path === '/config') return send(res, 200, maskConfig(currentConfig()))
      if (path === '/chat-sessions') {
        const store = readChatStore()
        return send(res, 200, { papers: store.papers, library: store.library ?? null })
      }
      if (path === '/chat-models') return send(res, 200, await chatModels(deps))
      if (path === '/paper-picker') {
        const q = query.get('q') ?? ''
        try {
          const r = await client.scoped().search({ query: q, limit: 8, qmode: 'titleCreatorYear' })
          return send(res, 200, {
            items: r.items.map((i) => ({ key: i.key, title: i.title, year: i.year, itemType: i.itemType })),
          })
        } catch (err: any) {
          return send(res, 200, { items: [], error: String(err?.message ?? err) })
        }
      }
      if (path === '/chat-messages' && query.get('sessionId')) {
        return send(res, 200, { messages: chatMessages(query.get('sessionId')!) })
      }
      if (path === '/pdf' && query.get('key')) {
        await streamPdf(req, res, client, query.get('key')!)
        return
      }
      if (path === '/open' && query.get('key')) {
        const attachmentKey = query.get('key')!
        const target = query.get('target') === 'system' ? 'system' : 'zotero'
        const p = await client.resolveAttachmentPath(attachmentKey)
        try {
          const { spawn } = await import('node:child_process')
          if (target === 'zotero') {
            // Zotero URL scheme：在 Zotero 内置阅读器打开该附件（正文/注释/文本选择）。
            const uri = `zotero://select/items/${attachmentKey}`
            const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
            const args = process.platform === 'win32' ? ['/c', 'start', '', uri] : [uri]
            spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
            return send(res, 200, { ok: true, target, uri, path: p ?? '' })
          }
          // System default handler (Windows start / macOS open / linux xdg-open).
          if (!p) return send(res, 200, { ok: false, error: '找不到附件文件路径' })
          const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
          const args = process.platform === 'win32' ? ['/c', 'start', '', p] : [p]
          spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
          return send(res, 200, { ok: true, target, path: p })
        } catch (err: any) {
          return send(res, 200, { ok: false, error: String(err?.message ?? err), path: p ?? '' })
        }
      }
      if (path === '/artifacts') return send(res, 200, { artifacts: readArtifacts(currentConfig()) })
    }

    if (req.method === 'POST') {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(req.body ?? '{}') as Record<string, unknown>
      } catch {
        /* empty body ok */
      }
      if (path === '/inject-context') return send(res, 200, await injectContext(deps, body))
      if (path === '/start-read') return send(res, 200, await startRead(deps, body))
      if (path === '/chat-open') return send(res, 200, await openPaperChatSession(deps, body))
      if (path === '/chat-open-library') return send(res, 200, await openLibraryChatSession(deps, body))
      if (path === '/chat-send') return send(res, 200, await sendChatMessage(deps, body))
      if (path === '/chat-select-model') return send(res, 200, await selectChatModel(deps, body))
      if (path === '/chat-history-delete') {
        const kind = String(body.kind ?? 'paper')
        const itemKey = String(body.itemKey ?? '')
        const store = readChatStore()
        let next = store
        if (kind === 'library') {
          next = { papers: store.papers }
        } else if (itemKey) {
          next = { papers: store.papers.filter((p) => p.itemKey !== itemKey), ...(store.library ? { library: store.library } : {}) }
        }
        writeChatStore(next)
        return send(res, 200, { ok: true, papers: next.papers, library: next.library ?? null })
      }
      if (path === '/config') {
        writeOverlay(body as Partial<ZoteroConfig>)
        const next = composeConfig()
        setActiveConfig(next)
        client.updateConfig(next)
        return send(res, 200, { ok: true, config: maskConfig(next) })
      }
      if (path === '/artifacts') {
        const artifact = body as { type?: string; title?: string; payload?: string }
        if (artifact.type && artifact.title) {
          appendArtifact(currentConfig(), { type: artifact.type, title: artifact.title, payload: String(artifact.payload ?? '').slice(0, 4000) })
          return send(res, 200, { ok: true, artifacts: readArtifacts(currentConfig()) })
        }
        return send(res, 400, { ok: false, error: 'artifact needs type+title' })
      }
      if (path === '/artifacts/clear') {
        writeArtifacts(currentConfig(), [])
        return send(res, 200, { ok: true, artifacts: [] })
      }
    }

    send(res, 404, { error: 'unknown dsh-zotero api endpoint', path })
  } catch (err: any) {
    send(res, 200, { error: String(err?.message ?? err), hint: err?.hint ?? '' })
  }
}

type Res = { writeHead(status: number, headers: Record<string, string>): unknown; end(body: string): unknown }

function readBody(req: any): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req?.on?.('data', (c: Buffer) => chunks.push(c))
    req?.on?.('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req?.on?.('error', () => resolve(''))
    if (!req?.on) resolve('')
  })
}

function send(res: Res, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Stream a Zotero attachment PDF (Chromium iframe/pdf viewer friendly, Range supported). */
async function streamPdf(
  req: { headers?: Record<string, string | string[] | undefined> },
  res: Res,
  client: ZoteroClient,
  attachmentKey: string,
): Promise<void> {
  const p = await client.resolveAttachmentPath(attachmentKey)
  if (!p) {
    send(res, 404, { error: '附件文件不可用（需 Local API 开启）' })
    return
  }
  try {
    const size = statSync(p).size
    const mime = /\.pdf$/i.test(p) ? 'application/pdf' : 'application/octet-stream'
    const rawRange = req.headers?.range
    const range = parseByteRange(rawRange, size)
    const base = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `inline; filename="${encodeURIComponent(p.split(/[\\/]/).pop() ?? 'file.pdf')}"`,
    }
    if (range) {
      const { start, end } = range
      res.writeHead(206, {
        ...base,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
      })
      createReadStream(p, { start, end }).pipe(res as unknown as NodeJS.WritableStream)
      return
    }
    res.writeHead(200, { ...base, 'Content-Length': String(size) })
    createReadStream(p).pipe(res as unknown as NodeJS.WritableStream)
  } catch (err: any) {
    send(res, 500, { error: String(err?.message ?? err) })
  }
}

function parseByteRange(raw: unknown, size: number): { start: number; end: number } | null {
  if (typeof raw !== 'string' || !raw.startsWith('bytes=')) return null
  const m = /bytes=(\d*)-(\d*)/.exec(raw)
  if (!m) return null
  const [, s, e] = m
  if (s === '' && e === '') return null
  const start = s === '' ? Math.max(0, size - Number(e)) : Number(s)
  const end = e === '' ? size - 1 : Number(e)
  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end < start || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

async function healthOf(client: ZoteroClient) {
  return client.health()
}

async function verifyOf(client: ZoteroClient) {
  const health = await client.health()
  const out: Record<string, unknown> = { health, search: null, collections: null }
  if (health.ok) {
    const s = await client.scoped().search({ limit: 3 })
    out.search = {
      ok: s.source !== 'none', total: s.total, source: s.source, error: s.error,
      sample: s.items.slice(0, 3).map((i) => ({ key: i.key, title: i.title, itemType: i.itemType, year: i.year })),
    }
    const c = await client.scoped().collections()
    out.collections = { total: c.total, source: c.source, error: c.error, roots: c.tree.filter((x) => x.depth === 0).slice(0, 20).map((x) => ({ key: x.key, name: x.name, itemCount: x.itemCount })) }
  }
  return out
}

async function treeOf(client: ZoteroClient, query: URLSearchParams) {
  const q = query.get('q')?.trim()
  const collection = query.get('collection')?.trim()
  const search = await client.scoped().search({
    limit: 40,
    query: q || undefined,
    qmode: q ? 'everything' : undefined,
    // q 与 collection 可并存（Local API 支持组合过滤）。
    collectionKey: collection || undefined,
  })
  const c = await client.scoped().collections()
  // 列表隐藏纯附件行（它们没有独立的文献价值）。
  const items = search.items.filter((i) => i.itemType !== 'attachment')
  return {
    source: search.source,
    recent: items.map((i) => ({ key: i.key, title: i.title, itemType: i.itemType, year: i.year, creators: i.creators.map((x) => x.fullName).slice(0, 3) })),
    total: search.total,
    collections: c.tree.map((x) => ({ key: x.key, name: x.name, parentKey: x.parentKey, depth: x.depth, itemCount: x.itemCount })),
    collectionsTotal: c.total,
    error: search.error || c.error,
  }
}

async function readOf(client: ZoteroClient, query: URLSearchParams) {
  const cfg = currentConfig()
  const itemKey = query.get('itemKey')!
  try {
    const parsed = await ensureParsed(client, cfg, (query.get('mode') as 'auto' | 'mineru' | 'text') ?? 'auto', itemKey, query.get('attachmentKey') ?? undefined)
    appendArtifact(cfg, { type: 'read', title: parsed.title || itemKey, payload: `${parsed.source} · ${parsed.textChars} 字符` })
    return {
      status: 'ok', itemKey, title: parsed.title, attachmentKey: parsed.attachmentKey,
      source: parsed.source, textChars: parsed.textChars, cacheDir: parsed.cacheDir,
      sectionTitles: parsed.md.split('\n').filter((l) => /^#{1,3}\s+/.test(l)).map((l) => l.replace(/^#{1,3}\s+/, '')).slice(0, 30),
      preview: parsed.md.slice(0, 800),
    }
  } catch (err: any) {
    return { status: 'error', itemKey, error: String(err?.message ?? err), hint: err?.hint ?? '' }
  }
}

/** Build the conversation-context text for one paper. */
async function buildPaperContext(deps: PanelApiDeps, body: Record<string, unknown>): Promise<{ ok: boolean; chars: number; text: string; error?: string }> {
  const client = deps.client
  const cfg = currentConfig()
  const itemKey = String(body.itemKey ?? '')
  if (!itemKey) return { ok: false, chars: 0, text: '', error: '缺少 itemKey' }
  const got = await client.scoped().getItem(itemKey)
  if (!got.found || !got.item) return { ok: false, chars: 0, text: '', error: `条目不存在: ${itemKey}` }
  const it = got.item
  const lines: string[] = []
  lines.push('【Zotero 文献上下文 · dsh-zotero 面板注入】')
  lines.push(`- 标题: ${it.title || '(无标题)'}`)
  const authors = it.creators.map((c) => c.fullName).filter(Boolean).join(', ')
  if (authors) lines.push(`- 作者: ${authors}`)
  if (it.year) lines.push(`- 年份: ${it.year}`)
  if (it.publicationTitle) lines.push(`- 期刊/来源: ${it.publicationTitle}`)
  if (it.doi) lines.push(`- DOI: ${it.doi}`)
  if (it.url) lines.push(`- URL: ${it.url}`)
  lines.push(`- 标签: ${it.tags.join(', ') || '(无)'}`)
  lines.push(`- Zotero key: ${it.key}（可调用 zotero_get_item / zotero_read_pdf 获取附件全文）`)
  if (it.abstractNote) lines.push(`- 摘要: ${it.abstractNote.slice(0, 1200)}`)
  const mode = String(body.mode ?? 'meta')
  if (mode === 'qa') {
    try {
      const parsed = await ensureParsed(client, cfg, 'auto', itemKey, String(body.attachmentKey ?? '') || undefined)
      const budget = Math.max(cfg.fullTextTokenBudget * 2, 8000)
      lines.push('【全文节选（缓存文本，供精读问答；可用 zotero_summarize 做定向总结）】')
      lines.push(parsed.md.slice(0, budget))
    } catch (err: any) {
      lines.push(`【全文解析失败：${String(err?.message ?? err)}】`)
    }
  }
  const text = lines.join('\n')
  return { ok: true, chars: text.length, text }
}

async function injectContext(deps: PanelApiDeps, body: Record<string, unknown>) {
  const built = await buildPaperContext(deps, body)
  if (!built.ok) return { ok: false, error: built.error ?? '构建上下文失败' }
  const sessionId = String(body.sessionId ?? '')
  const agents = deps.agents as { get?(id: unknown): { inject?(msg: unknown): unknown } | undefined } | undefined
  const agent = agents?.get?.(sessionId)
  if (!agent?.inject) {
    return { ok: false, error: '无法定位会话 agent（sessionId 无效或会话未激活）', chars: built.chars }
  }
  try {
    agent.inject({
      content: [{ type: 'text', text: built.text }],
      source: { kind: 'plugin', plugin: PLUGIN_ID },
    })
    return { ok: true, chars: built.chars, sessionId }
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err), chars: built.chars }
  }
}

/** 「开读」：注入 QA 上下文 + followup 唤起一次模型阅读轮次。 */
async function startRead(deps: PanelApiDeps, body: Record<string, unknown>) {
  const built = await buildPaperContext(deps, body)
  if (!built.ok) return { ok: false, error: built.error ?? '构建上下文失败' }
  const sessionId = String(body.sessionId ?? '')
  const agents = deps.agents as
    | { get?(id: unknown): { inject?(msg: unknown): unknown; followup?(msg: unknown): unknown } | undefined }
    | undefined
  const agent = agents?.get?.(sessionId)
  if (!agent?.inject) {
    return { ok: false, error: '无法定位会话 agent（sessionId 无效或会话未激活）', chars: built.chars }
  }
  try {
    agent.inject({
      content: [{ type: 'text', text: built.text }],
      source: { kind: 'plugin', plugin: PLUGIN_ID },
    })
    if (typeof agent.followup === 'function') {
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: READ_PROMPT }],
          source: { kind: 'user' },
        }),
      )
      return { ok: true, chars: built.chars, sessionId, followup: true }
    }
    return { ok: true, chars: built.chars, sessionId, followup: false, note: '已注入上下文；请手动在对话中输入阅读指令' }
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err), chars: built.chars }
  }
}

function maskConfig(cfg: ZoteroConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(cfg)) {
    out[k] = SECRET_FIELDS.has(k) && String(v) ? '•••（已设置）' : v
  }
  out.cacheDir = resolveCacheDir(cfg)
  return out
}

/* ── artifacts store ───────────────────────────────────────────────── */

interface Artifact { type: string; title: string; payload: string; at: string }

function artifactsPath(cfg: ZoteroConfig): string {
  return join(resolveCacheDir(cfg), 'artifacts.json')
}

function readArtifacts(cfg: ZoteroConfig): Artifact[] {
  try {
    const p = artifactsPath(cfg)
    if (!existsSync(p)) return []
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Artifact[]
    return Array.isArray(raw) ? raw.slice(-50) : []
  } catch {
    return []
  }
}

function appendArtifact(cfg: ZoteroConfig, a: { type: string; title: string; payload: string }): Artifact[] {
  const list = readArtifacts(cfg)
  list.push({ ...a, at: new Date().toISOString() })
  writeArtifacts(cfg, list)
  return list
}

function writeArtifacts(cfg: ZoteroConfig, list: Artifact[]): void {
  try {
    const p = artifactsPath(cfg)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, JSON.stringify(list.slice(-50), null, 2), 'utf8')
  } catch { /* artifacts are best-effort */ }
}

export { PLUGIN_ID as PANEL_PLUGIN_ID }
