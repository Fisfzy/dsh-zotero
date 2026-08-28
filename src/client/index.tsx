/**
 * @dsh-external/dsh-zotero — client 面板（conversation.view tab，React）。
 *
 * 库（检索/收藏夹/详情/PDF 内嵌预览/读全文/概述/开读直达）
 * · 产出物区 · 设置（MinerU 等，settings.json 热生效）。
 * 「开读」与「送入」都走 /inject-context & /start-read（host agent.inject/followup）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'

type ClientContext = { slots: SlotsService }

export const inject = ['slots']

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

const CSS = `
.dshz{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12.5px;--dshz-bg:#1b1d21;--dshz-panel:#24272c;--dshz-line:#33373e;--dshz-fg:#d8dbe0;--dshz-dim:#8a919c;--dshz-accent:#4f8cff;}
.dshz *{box-sizing:border-box}
.dshz-h{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dshz-line);background:var(--dshz-bg);position:sticky;top:0;z-index:3}
.dshz-h .dot{width:8px;height:8px;border-radius:50%;background:var(--dshz-dim);flex:none}
.dshz-h b{font-size:12px;color:var(--dshz-fg)}
.dshz-h .st{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dshz-dim);font-size:11px}
.dshz-btn{background:#2a2e35;color:var(--dshz-fg);border:1px solid var(--dshz-line);border-radius:6px;padding:4px 8px;font-size:11.5px;cursor:pointer;white-space:nowrap}
.dshz-btn:hover{background:#343a43}
.dshz-btn.primary{background:var(--dshz-accent);border-color:transparent;color:#fff}
.dshz-btn:disabled{opacity:.5;cursor:default}
.dshz-tabs{display:flex;gap:2px;padding:6px 8px 0;border-bottom:1px solid var(--dshz-line)}
.dshz-tab{padding:5px 10px;border-radius:6px 6px 0 0;cursor:pointer;color:var(--dshz-dim);border:1px solid transparent}
.dshz-tab.on{color:var(--dshz-accent);border-color:var(--dshz-line);border-bottom-color:transparent;background:var(--dshz-panel)}
.dshz-b{flex:1;min-height:0;overflow:auto;background:var(--dshz-panel);padding:8px}
.dshz-row{padding:7px 8px;border:1px solid var(--dshz-line);border-radius:8px;margin-bottom:6px;background:#202329;cursor:pointer}
.dshz-row:hover{border-color:var(--dshz-accent)}
.dshz-row .t{color:var(--dshz-fg);font-size:12.5px;line-height:1.35}
.dshz-row .m{color:var(--dshz-dim);font-size:11px;margin-top:3px;display:flex;gap:8px;flex-wrap:wrap}
.dshz-badge{font-size:10px;border-radius:4px;padding:1px 5px;background:#31353d;color:var(--dshz-dim)}
.dshz-badge.pdf{background:#2c3e50;color:#7fb3ff}
.dshz-badge.summary{background:#2c3e50;color:#7fb3ff}
.dshz-input{width:100%;background:#1e2126;border:1px solid var(--dshz-line);border-radius:6px;color:var(--dshz-fg);padding:5px 8px;font-size:12px}
.dshz-sel{background:#1e2126;border:1px solid var(--dshz-line);border-radius:6px;color:var(--dshz-fg);padding:4px 6px;font-size:11.5px;width:100%}
.dshz-kv{color:var(--dshz-dim);font-size:11px}
.dshz-kv b{color:var(--dshz-fg);font-weight:500}
.dshz-note{color:var(--dshz-dim);font-size:11px;line-height:1.5}
.dshz-banner{border-radius:6px;padding:6px 8px;font-size:11px;margin-bottom:8px}
.dshz-banner.err{background:#3a2020;color:#ff9c9c}
.dshz-banner.ok{background:#1d3324;color:#8fd9a0}
.dshz-null{padding:18px 8px;text-align:center;color:var(--dshz-dim);font-size:12px}
.dshz-pdf{position:relative;border:1px solid var(--dshz-line);border-radius:8px;background:#111;margin-bottom:8px;overflow:hidden}
.dshz-pdf iframe{display:block;width:100%;height:420px;border:0}
.dshz-pdf .bar{position:absolute;top:4px;right:4px;z-index:2;display:flex;gap:4px}
.dshz-field{margin-bottom:8px}
.dshz-field label{display:block;color:var(--dshz-dim);font-size:11px;margin-bottom:2px}
.dshz-sec{color:var(--dshz-fg);font-size:12px;font-weight:600;margin:10px 0 6px;border-bottom:1px solid var(--dshz-line);padding-bottom:3px}
`

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

  async function readItem(key: string): Promise<void> {
    setBusy('解析全文（首次较慢，之后走缓存）…')
    const r = await apiGet(`/read?itemKey=${encodeURIComponent(key)}`)
    setBusy('')
    if (r.status === 'ok') {
      setNote(`✅ 已解析：${r.source} · ${r.textChars} 字符`)
    } else {
      setNote(`⚠️ ${r.error ?? '解析失败'}`)
    }
    apiGet('/artifacts').then((x) => setArtifacts(x.artifacts ?? [])).catch(() => {})
  }

  async function summarizeItem(key: string): Promise<void> {
    setBusy('生成概述（默认模型，约 30–90s）…')
    const r = await apiGet(`/summarize?itemKey=${encodeURIComponent(key)}&mode=overview`)
    setBusy('')
    if (r.status === 'ok') {
      setDetail((d: any) => ({ ...d, summary: r.summary }))
    } else {
      setNote(`⚠️ ${r.error ?? '概述生成失败'}`)
    }
    apiGet('/artifacts').then((x) => setArtifacts(x.artifacts ?? [])).catch(() => {})
  }

  async function injectItem(key: string, mode: 'meta' | 'qa'): Promise<void> {
    if (!sessionId) {
      setNote('⚠️ 未拿到当前会话 id——请在对话页打开此面板后重试。')
      return
    }
    setBusy(mode === 'qa' ? '组装全文上下文…' : '组装元数据…')
    const r = await apiPost('/inject-context', { itemKey: key, mode, sessionId })
    setBusy('')
    if (r.ok) {
      setNote(`✅ 已送入当前对话（${r.chars} 字符）。上下文已进入会话，直接追问精读问题即可。`)
    } else {
      setNote(`❌ ${r.error ?? '注入失败'}`)
    }
  }

  async function startRead(key: string): Promise<void> {
    if (!sessionId) {
      setNote('⚠️ 未拿到当前会话 id——请在对话页打开此面板后重试。')
      return
    }
    setBusy('唤起 Chat 精读（注入全文 + 发送阅读指令）…')
    const r = await apiPost('/start-read', { itemKey: key, mode: 'qa', sessionId })
    setBusy('')
    if (r.ok) {
      setNote(r.followup ? '🚀 已唤起 Chat：切到「对话」tab，模型正在精读这篇论文。' : `✅ 已注入上下文（${r.chars} 字符）。`)
    } else {
      setNote(`❌ ${r.error ?? '开读失败'}`)
    }
  }

  async function openPdf(attachmentKey: string, target: 'zotero' | 'system' = 'zotero'): Promise<void> {
    setBusy(target === 'zotero' ? '唤起 Zotero 阅读器…' : '系统打开 PDF…')
    const r = await apiGet(`/open?key=${encodeURIComponent(attachmentKey)}&target=${target}`)
    setBusy('')
    if (r.ok) {
      setNote(target === 'zotero'
        ? '📖 已在 Zotero 内置阅读器打开（侧边栏注释/文本选择可用）。'
        : `📄 已用系统默认程序打开：${r.path ?? ''}`)
    } else {
      setNote(`⚠️ ${r.error ?? '打开失败'}`)
    }
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
                    <span className="dshz-note" style={{ flex: 1, minWidth: 120, maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dshz-fg)', fontSize: 12 }}>
                      {reading.title || 'PDF'}
                    </span>
                    <button className="dshz-btn primary" onClick={() => void startRead(reading.key)}>开读 · 唤起Chat</button>
                    <button className="dshz-btn" onClick={() => void summarizeItem(reading.key)}>概述</button>
                    <button className="dshz-btn" onClick={() => void injectItem(reading.key, 'qa')}>送入全文</button>
                    <button className="dshz-btn" onClick={() => void readItem(reading.key)}>读全文</button>
                    <button className="dshz-btn" onClick={() => void openPdf(reading.attachmentKey, 'zotero')}>Zotero 阅读器</button>
                    <button className="dshz-btn" onClick={() => void openPdf(reading.attachmentKey, 'system')}>系统打开</button>
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
                          <button className="dshz-btn primary" onClick={() => void startRead(detailItem.key)}>开读 · 唤起Chat</button>
                          <button className="dshz-btn" onClick={() => void injectItem(detailItem.key, 'meta')}>送入当前对话</button>
                          <button className="dshz-btn" onClick={() => void injectItem(detailItem.key, 'qa')}>送入全文·精读问答</button>
                          <button className="dshz-btn" onClick={() => void readItem(detailItem.key)}>读全文</button>
                          <button className="dshz-btn" onClick={() => void summarizeItem(detailItem.key)}>概述</button>
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
}
