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
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

const SECRET_FIELDS = new Set(['localApiKey', 'webApiKey', 'mineruCloudApiKey'])

export interface PanelApiDeps {
  client: ZoteroClient
  llm: LlmService
  agentDefaultModel: { currentSelection(): ResolvedModel } | undefined
  /** Host agent service (optional) — used by /inject-context. */
  agents: unknown
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
