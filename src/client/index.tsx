/**
 * @dsh-external/dsh-zotero — client 面板（conversation.view tab，React）。
 *
 * 库（检索/收藏夹/详情/PDF 内嵌预览/读全文/概述/开读直达）
 * · 产出物区 · 设置（MinerU 等，settings.json 热生效）。
 * 「开读」与「送入」都走 /inject-context & /start-read（host agent.inject/followup）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'
import { CSS } from './theme'
import { ChatWindow, dispatchChatOpen } from './ChatWindow'

/** ClientContext 需要的最小签名（sessions.create/list 见 dsh-api-session-controller/client）。 */
type ClientContext = {
  slots: SlotsService
  sessions: {
    create(opts?: { workspaceId?: string; cwd?: string; sessionId?: string }): Promise<string>
    list: {
      getSnapshot(): { byId: Record<string, { cwd?: string }> }
    }
  }
}

export const inject = ['slots', 'sessions']

/** 浮动文献聊天窗的独立 React root（挂 document.body；不占面板 tab）。 */
let WIN_ROOT: Root | null = null
/** apply() 注入的 client sessions 服务（dispatch 时取父会话 cwd）。 */
let SESSIONS: ClientContext['sessions'] | null = null

/** 当前面板会话的 cwd（文献会话创建时作为 meta.cwd，persona 提示词变量需要）。 */
function currentCwd(sessionId: string): string {
  try {
    return SESSIONS?.list?.getSnapshot()?.byId?.[sessionId]?.cwd ?? ''
  } catch {
    return ''
  }
}

const API = '/@dsh-external/dsh-zotero/api'

async function apiGet(path: string): Promise<any> {
  return (await fetch(`${API}${path}`)).json()
}

async function apiPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return res.json()
}

interface TreeNode { key: string; name: string; depth: number; itemCount?: number }
interface RecentItem { key: string; title: string; itemType: string; year?: number }
interface Artifact { type: string; title: string; payload: string; at: string }

export function ZoteroPanel(props: { sessionId?: string } & Record<string, unknown>): JSX.Element {
  const [sessionId, setSessionId] = useState<string>(String(props.sessionId ?? ''))
  const [status, setStatus] = useState<Record<string, unknown> | null>(null)
  const [tab, setTab] = useState<'lib' | 'out' | 'cfg'>('lib')
  const [query, setQuery] = useState('')
  const [collectionKey, setCollectionKey] = useState('')
  const [recent, setRecent] = useState<RecentItem[]>([])
  const [collections, setCollections] = useState<TreeNode[]>([])
  const [detail, setDetail] = useState<any>(null)
  const [busy, setBusy] = useState('')
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [form, setForm] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  /** 阅读模式：{论文 key, 标题, PDF 附件 key}；非空时面板主体 = PDF 阅读器。 */
  const [reading, setReading] = useState<{ key: string; title: string; attachmentKey: string } | null>(null)
  const sessionRef = useRef(props.sessionId)
  useEffect(() => {
    if (props.sessionId && props.sessionId !== sessionRef.current) {
      sessionRef.current = props.sessionId
      setSessionId(String(props.sessionId))
    }
  }, [props.sessionId])

  async function loadBasics(): Promise<void> {
    setBusy('连接检测…')
    try {
      const [v, tree] = await Promise.all([apiGet('/verify'), apiGet('/tree')])
      setStatus(v.health)
      setRecent((tree.recent ?? []).filter((i: RecentItem) => i.itemType !== 'attachment'))
      setCollections(tree.collections ?? [])
    } catch (err: any) {
      setNote(`加载失败: ${String(err?.message ?? err)}`)
    }
    setBusy('')
  }

  useEffect(() => {
    void loadBasics()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (tab === 'out') void apiGet('/artifacts').then((r) => setArtifacts(r.artifacts ?? [])).catch(() => {})
    if (tab === 'cfg') {
      void apiGet('/config').then((r) => {
        setConfig(r ?? {})
        const f: Record<string, string> = {}
        for (const [k, v] of Object.entries(r ?? {})) {
          if (typeof v === 'object') continue
          if (String(v).startsWith('•••')) continue
          f[k] = String(v ?? '')
        }
        setForm(f)
      }).catch(() => {})
    }
  }, [tab])

  /** 检索（参数显式传入，避免 setState 闭包读到旧值）。 */
  async function runSearch(q: string, coll: string): Promise<void> {
    setBusy('检索…')
    try {
      const qs = new URLSearchParams()
      if (q.trim()) qs.set('q', q.trim())
      if (coll) qs.set('collection', coll)
      const tree = await apiGet(`/tree${qs.size ? `?${qs.toString()}` : ''}`)
      setRecent((tree.recent ?? []).filter((i: RecentItem) => i.itemType !== 'attachment'))
    } catch (err: any) {
      setNote(`检索失败: ${String(err?.message ?? err)}`)
    }
    setBusy('')
  }

  async function doSearch(): Promise<void> {
    await runSearch(query, collectionKey)
  }

  /** 点论文 → 整页进入 PDF 阅读模式（有 PDF 附件时）。 */
  async function openItem(key: string): Promise<void> {
    setBusy('打开条目…')
    try {
      const got = await apiGet(`/item?key=${encodeURIComponent(key)}`)
      setBusy('')
      setDetail(got)
      const pdf = (got.item?.attachments ?? []).find((a: any) => a.isPdf)
      if (pdf) {
        setReading({ key, title: got.item?.title ?? '', attachmentKey: pdf.key })
      }
    } catch (err: any) {
      setBusy('')
      setDetail({ error: String(err?.message ?? err) })
    }
  }

  /** 文献 CHAT → 文献聊天（M3.2：独立会话，不碰主对话；点开只注入全文，不自动发精读指令）。 */
  async function openReadChat(key: string, title: string): Promise<void> {
    dispatchChatOpen({ target: 'paper', itemKey: key, title, parent: sessionId, cwd: currentCwd(sessionId) })
    setNote(`💬 已打开《${title.slice(0, 30)}…》的文献 Chat（全文已注入）——在浮窗里点快捷操作或直接提问即可。`)
  }

  async function saveConfig(): Promise<void> {
    setBusy('保存设置…')
    const patch: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(form)) {
      if (String(v) === String(config[k] ?? '')) continue
      if (v === '') {
        // 秘钥留空=不改（沿用）；其它字段允许清空。
        if (['localApiKey', 'webApiKey', 'mineruCloudApiKey'].includes(k)) continue
      }
      patch[k] = v
    }
    const r = await apiPost('/config', patch)
    setBusy('')
    if (r.ok) {
      setConfig(r.config ?? {})
      setNote('✅ 设置已保存并热生效（MinerU/端口等下次调用即用新值；重载插件后依然保留）。')
    } else {
      setNote(`❌ ${r.error ?? '保存失败'}`)
    }
  }

  const detailItem = detail?.item
  const dot = status ? (status.ok ? '#2ecc71' : '#e6a23c') : '#e74c3c'
  const statusText = status
    ? status.ok
      ? `已连接 Zotero（${String(status.source ?? '')}）`
      : `未连接 — ${String(status.hint ?? '').slice(0, 50)}`
    : '检测中…'

  const field = (key: string, label: string, kind: 'text' | 'password' | 'number' = 'text') => {
    const val = form[key] ?? ''
    const isSecret = kind === 'password'
    return (
      <div className="dshz-field" key={key}>
        <label>{label}</label>
        <input
          className="dshz-input"
          type={kind}
          value={val}
          placeholder={isSecret && (config as any)[key] ? '••• 已设置，留空不改' : ''}
          onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        />
      </div>
    )
  }

  return (
    <div className="dshz" style={{ background: 'var(--dshz-panel)' }} data-dshz-root>
      <style>{CSS}</style>
      <div className="dshz-h">
        <span className="dot" style={{ background: dot }} />
        <b>Zotero</b>
        <span className="st" title={statusText}>{statusText}</span>
        <button className="dshz-btn" onClick={() => void dispatchChatOpen({ target: 'library', parent: sessionId, cwd: currentCwd(sessionId) })}>🧠 文献 Chat</button>
        <button className="dshz-btn" onClick={() => void loadBasics()}>刷新</button>
      </div>
      <div className="dshz-tabs">
        <div className={`dshz-tab ${tab === 'lib' ? 'on' : ''}`} onClick={() => setTab('lib')}>库</div>
        <div className={`dshz-tab ${tab === 'out' ? 'on' : ''}`} onClick={() => setTab('out')}>产出物 ({artifacts.length})</div>
        <div className={`dshz-tab ${tab === 'cfg' ? 'on' : ''}`} onClick={() => setTab('cfg')}>设置</div>
      </div>
      <div className="dshz-b">
        {busy ? <div className="dshz-banner ok">⏳ {busy}</div> : null}
        {note ? <div className="dshz-banner ok">{note}</div> : null}
        {tab === 'lib' && (
          <>
            {reading ? (
              /* ── 阅读模式：面板主体 = PDF 阅读器 ── */
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 480 }}>
                <div className="dshz-row" style={{ cursor: 'default', background: '#1e232a', marginTop: 0 }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button className="dshz-btn" onClick={() => setReading(null)}>← 列表</button>
                    <span className="dshz-note" style={{ flex: 1, minWidth: 120, maxWidth: '40%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dshz-fg)', fontSize: 12 }}>
                      {reading.title || 'PDF'}
                    </span>
                    <button className="dshz-btn primary" onClick={() => void openReadChat(reading.key, reading.title)}>📄 文献 CHAT</button>
                    <button className="dshz-btn" onClick={() => void dispatchChatOpen({ target: 'library', parent: sessionId, cwd: currentCwd(sessionId) })}>📚 文献库 CHAT</button>
                  </div>
                  {detail?.item && (
                    <div className="dshz-kv" style={{ marginTop: 6 }}>
                      {detail.item.creators?.length ? <span>作者: {detail.item.creators.map((c: any) => c.fullName).join(', ')} · </span> : null}
                      {detail.item.year ? <span>{detail.item.year} · </span> : null}
                      {detail.item.publicationTitle ? <span>{detail.item.publicationTitle} · </span> : null}
                      {detail.item.doi ? <span>DOI {detail.item.doi}</span> : null}
                    </div>
                  )}
                </div>
                <iframe
                  title={reading.title || 'PDF'}
                  src={`${API}/pdf?key=${encodeURIComponent(reading.attachmentKey)}`}
                  style={{ flex: 1, width: '100%', border: '1px solid var(--dshz-line)', borderRadius: 8, background: '#111' }}
                />
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <input
                    className="dshz-input"
                    placeholder="检索标题/作者/标签/全文…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void doSearch() }}
                  />
                  <button className="dshz-btn primary" onClick={() => void doSearch()}>检索</button>
                </div>
                <select
                  className="dshz-sel"
                  style={{ marginBottom: 6 }}
                  value={collectionKey}
                  onChange={(e) => {
                    const v = e.target.value
                    setCollectionKey(v)
                    void runSearch(query, v)
                  }}
                >
                  <option value="">全部收藏夹</option>
                  {collections.map((c) => (
                    <option key={c.key} value={c.key}>
                      {'│ '.repeat(Math.min(c.depth, 8))}{c.name} ({c.itemCount ?? '?'})
                    </option>
                  ))}
                </select>
                <div className="dshz-note" style={{ marginBottom: 6 }}>
                  点击条目 = 进入 PDF 阅读（列页面切换）；无 PDF 的条目显示详情卡；「开读」一键唤起 Chat 精读。
                </div>
                {recent.length === 0 && <div className="dshz-null">暂无数据 — 点右上「刷新」</div>}
                {recent.map((i) => (
                  <div className="dshz-row" key={i.key} onClick={() => void openItem(i.key)}>
                    <div className="t">{i.title || '(无标题)'}</div>
                    <div className="m">
                      <span className="dshz-badge">{i.itemType}</span>
                      {i.year ? <span>{i.year}</span> : null}
                    </div>
                  </div>
                ))}
                {detail && (
                  <div className="dshz-row" style={{ cursor: 'default', background: '#1e232a' }}>
                    {detail.loading ? <div className="dshz-null">加载条目…</div> : !detailItem ? (
                      <div className="dshz-null">{String(detail.error ?? '加载失败')}</div>
                    ) : (
                      <>
                        <div className="t">{detailItem.title || '(无标题)'}</div>
                        <div className="dshz-kv" style={{ marginTop: 6, lineHeight: 1.7 }}>
                          {detailItem.creators?.length ? (
                            <div>作者：<b>{detailItem.creators.map((c: any) => c.fullName).join(', ')}</b></div>
                          ) : null}
                          {(detailItem.year || detailItem.publicationTitle || detailItem.doi) ? (
                            <div>
                              {detailItem.year ? <b>{detailItem.year}</b> : null}
                              {detailItem.publicationTitle ? ` · ${detailItem.publicationTitle}` : ''}
                              {detailItem.doi ? ` · DOI ${detailItem.doi}` : ''}
                            </div>
                          ) : null}
                          {detailItem.tags?.length ? <div>标签：{detailItem.tags.join(', ')}</div> : null}
                          {detailItem.abstractNote ? (
                            <div style={{ maxHeight: 96, overflow: 'auto' }}>
                              摘要：{detailItem.abstractNote.slice(0, 900)}
                            </div>
                          ) : null}
                        </div>
                        <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button className="dshz-btn primary" onClick={() => void openReadChat(String(detailItem.key), String(detailItem.title ?? ''))}>📄 文献 CHAT</button>
                          <button className="dshz-btn" onClick={() => void dispatchChatOpen({ target: 'library', parent: sessionId, cwd: currentCwd(sessionId) })}>📚 文献库 CHAT</button>
                        </div>
                        {detailItem.attachments?.length ? (
                          <div className="dshz-note" style={{ marginTop: 8 }}>
                            附件 {detailItem.attachments.length}：
                            {detailItem.attachments.map((a: any) => (
                              <span
                                key={a.key}
                                className={`dshz-badge ${a.isPdf ? 'pdf' : ''}`}
                                style={a.isPdf ? { cursor: 'pointer' } : undefined}
                                title={a.isPdf ? '面板内预览' : undefined}
                                onClick={a.isPdf ? () => setReading({ key: detailItem.key, title: detailItem.title || '', attachmentKey: a.key }) : undefined}
                              >
                                {String(a.title ?? '').slice(0, 26)}{a.isPdf ? ' · PDF▶' : ''}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {detail.summary ? (
                          <div className="dshz-note" style={{ marginTop: 8, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                            {detail.summary}
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                )}
              </>
            )}
            </>
          )}
        {tab === 'out' && (
          <>
            {artifacts.length === 0 ? <div className="dshz-null">暂无产出物 — 读全文/概述后自动沉淀在这里</div> : null}
            {artifacts.map((a, idx) => (
              <div className="dshz-row" key={`${a.at}-${idx}`} style={{ cursor: 'default' }}>
                <div className="m">
                  <span className={`dshz-badge ${a.type === 'summary' ? 'summary' : ''}`}>{a.type}</span>
                  <span>{String(a.at).slice(0, 16).replace('T', ' ')}</span>
                </div>
                <div className="t">{a.title}</div>
                <div className="dshz-kv" style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>
                  {String(a.payload ?? '').slice(0, 600)}
                </div>
                <button
                  className="dshz-btn"
                  onClick={() => void navigator.clipboard.writeText(String(a.payload ?? '')).catch(() => {})}
                >
                  复制
                </button>
              </div>
            ))}
            {artifacts.length ? (
              <button className="dshz-btn" onClick={() => void apiPost('/artifacts/clear', {}).then((x) => setArtifacts(x.artifacts ?? []))}>清空产出物</button>
            ) : null}
          </>
        )}
        {tab === 'cfg' && (
          <>
            <div className="dshz-note" style={{ marginBottom: 6 }}>
              保存即热生效（写入 <code>settings.json</code>，重启/重载后依然保留；秘钥留空 = 不改）。
            </div>
            <div className="dshz-sec">Zotero 连接</div>
            {field('localApiPort', '本地 API 端口（Zotero httpServer，默认 23119）', 'number')}
            {field('localApiKey', '本地 API Key（开启密钥认证时填写）', 'password')}
            {field('webUserId', 'Web API userId（桌面关闭时降级，可留空）')}
            {field('webApiKey', 'Web API Key', 'password')}
            {field('storageDir', '存储目录（可选，PDF 直读兜底）')}
            {field('searchLimit', '检索默认条数', 'number')}
            <div className="dshz-sec">MinerU 解析</div>
            <div className="dshz-field">
              <label>后端模式</label>
              <select className="dshz-sel" value={form.mineruMode ?? 'local'} onChange={(e) => setForm((f) => ({ ...f, mineruMode: e.target.value }))}>
                <option value="local">本地 mineru-api（127.0.0.1:8000）</option>
                <option value="cloud">云端 mineru.net（需 API Key）</option>
              </select>
            </div>
            {field('mineruLocalApiBase', '本地 MinerU 服务地址')}
            <div className="dshz-field">
              <label>本地后端引擎</label>
              <select className="dshz-sel" value={form.mineruLocalBackend ?? 'pipeline'} onChange={(e) => setForm((f) => ({ ...f, mineruLocalBackend: e.target.value }))}>
                <option value="pipeline">pipeline</option>
                <option value="vlm">vlm（vlm-auto-engine）</option>
                <option value="hybrid">hybrid（hybrid-auto-engine）</option>
              </select>
            </div>
            {field('mineruCloudApiKey', 'MinerU 云端 API Key', 'password')}
            <div className="dshz-field">
              <label>云端模型</label>
              <select className="dshz-sel" value={form.mineruCloudModel ?? 'vlm'} onChange={(e) => setForm((f) => ({ ...f, mineruCloudModel: e.target.value }))}>
                <option value="vlm">vlm（默认）</option>
                <option value="pipeline">pipeline</option>
              </select>
            </div>
            <div className="dshz-field">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={form.mineruForceOcr === 'true'} onChange={(e) => setForm((f) => ({ ...f, mineruForceOcr: String(e.target.checked) }))} />
                强制 OCR
              </label>
            </div>
            {field('mineruMaxAutoPages', '自动解析页数上限（daemon/后台）', 'number')}
            <div className="dshz-sec">精读</div>
            {field('fullTextTokenBudget', '单次全文 token 预算', 'number')}
            {field('cacheDir', '缓存目录（留空=默认）')}
            <div className="dshz-field">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={form.ragEnabled === 'true'} onChange={(e) => setForm((f) => ({ ...f, ragEnabled: String(e.target.checked) }))} />
                RAG 库级检索（M4，先保持关）
              </label>
            </div>
            <div className="dshz-field">
              <label>概述 prompt 覆盖（留空=默认）</label>
              <textarea className="dshz-input" rows={3} value={form.summaryPrompt ?? ''} onChange={(e) => setForm((f) => ({ ...f, summaryPrompt: e.target.value }))} />
            </div>
            <div className="dshz-field">
              <label>翻译 prompt 覆盖</label>
              <textarea className="dshz-input" rows={3} value={form.translatePrompt ?? ''} onChange={(e) => setForm((f) => ({ ...f, translatePrompt: e.target.value }))} />
            </div>
            <div className="dshz-field">
              <label>开读/精读指引 prompt 覆盖（注入式）</label>
              <textarea className="dshz-input" rows={3} value={form.chatWithPdfPrompt ?? ''} onChange={(e) => setForm((f) => ({ ...f, chatWithPdfPrompt: e.target.value }))} />
            </div>
            <button className="dshz-btn primary" style={{ marginTop: 4 }} onClick={() => void saveConfig()}>保存设置（热生效）</button>
          </>
        )}
      </div>
    </div>
  )
}

export function apply(ctx: ClientContext): void {
  SESSIONS = ctx.sessions
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register(
          {
            name: 'conversation.view',
            id: '@dsh-external/dsh-zotero-panel',
            order: 80,
            label: () => 'Zotero',
            inject: (sessionId: unknown) => ({ sessionId: String(sessionId ?? '') }),
          },
          ZoteroPanel,
        ),
      ),
    '@dsh-external/dsh-zotero: panel',
  )

  // 浮动文献聊天窗：独立 React root（不占面板 tab；关闭=隐藏、会话保留）。
  ctx.effect(() => {
    const host = document.createElement('div')
    host.setAttribute('data-dshz-chat-window', '')
    document.body.appendChild(host)
    WIN_ROOT = createRoot(host)
    WIN_ROOT.render(<ChatWindow />)
    return () => {
      try { WIN_ROOT?.unmount() } catch { /* best-effort */ }
      WIN_ROOT = null
      host.remove()
    }
  }, '@dsh-external/dsh-zotero: chat window')
}
