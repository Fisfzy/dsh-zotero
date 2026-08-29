/**
 * dsh-zotero — 独立浮动文献聊天窗（M3.2 rev3）。
 *
 * 对照原版 llm-for-zotero 对话框补齐（用户确认范围）：
 *   A 组：顶部分段「Paper chat | 文献库对话」+ 当前论文标题、欢迎首屏、
 *         History 删除、Diagram pill
 *   B 组：@论文 引用（左键点标签=发送 PDF；右键=切换 全文/元数据 模式）、
 *         会话级模型选择器（host sessionController.selectModel）
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { CSS } from './theme'

const API = '/@dsh-external/dsh-zotero/api'
const OPEN_EVENT = 'dshz:chat-open'

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

export interface ChatMsg {
  kind: 'user' | 'assistant' | 'tool'
  text: string
  name?: string
  running?: boolean
  ok?: boolean
  at: number
}

interface PaperEntry {
  itemKey: string
  title: string
  sessionId: string
  injectedAt: number
  at: number
}

interface LibraryEntry {
  sessionId: string
  injectedAt: number
  at: number
}

interface ActiveSession {
  kind: 'paper' | 'library'
  itemKey?: string
  title: string
  sessionId: string
}

interface PaperChip {
  itemKey: string
  title: string
  mode: 'pdf' | 'meta'
}

interface ModelOption {
  provider: string
  model: string
  name: string
}

const PAPER_PILLS: Array<{ label: string; text: string }> = [
  { label: '概述', text: '请用中文概述这篇论文：核心问题、主要方法、关键结果（带数字）、作者解读。' },
  { label: '要点', text: '请列出这篇论文的 Key Points（每个要点 1-2 句，按重要性排序）。' },
  { label: '方法', text: '请详细说明论文的方法：公式/模型/实验设置，以及每一步的作用。' },
  { label: '局限', text: '请指出论文的局限（原文明确的 + 你的推断，并注明区分）。' },
  { label: '读全文', text: '请通读全文并给出结构化精读：一句话主线 + 章节要点 + 3 个可追问问题。' },
  { label: 'Diagram', text: '请列出论文中的主要图/表/公式：每张图说明其展示内容与结论，关键公式给出符号含义与作用（标明所在章节）。' },
]

const LIBRARY_PILLS: Array<{ label: string; text: string }> = [
  { label: '检索示例', text: '我库里有讲述业动力学/近场力学的论文吗？列出 5 篇并各用一句说明。' },
  { label: '库综述', text: '按方法类型分类总结本库文献，每类给出代表工作。' },
  { label: '收藏夹剖析', text: '我收藏夹里最近添加的论文讲了什么？按主题归纳并按重要性排序。' },
]

/** 浮窗打开请求（面板 dispatch / 本窗监听）。 */
export function dispatchChatOpen(detail:
  | { target: 'paper'; itemKey: string; title: string; sendRead?: boolean; parent?: string; cwd?: string }
  | { target: 'library'; parent?: string; cwd?: string }
): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail }))
}

export function ChatWindow(): JSX.Element {
  const [hidden, setHidden] = useState(true)
  const [booting, setBooting] = useState(false)
  const [note, setNote] = useState('')
  const [papers, setPapers] = useState<PaperEntry[]>([])
  const [library, setLibrary] = useState<LibraryEntry | null>(null)
  const [active, setActive] = useState<ActiveSession | null>(null)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  /* @论文 引用 */
  const [chips, setChips] = useState<PaperChip[]>([])
  const [atOpen, setAtOpen] = useState(false)
  const [atQuery, setAtQuery] = useState('')
  const [atItems, setAtItems] = useState<Array<{ key: string; title: string; year?: number; itemType?: string }>>([])
  /* 模型选择 */
  const [models, setModels] = useState<ModelOption[]>([])
  const [currentModel, setCurrentModel] = useState('')
  const [modelBusy, setModelBusy] = useState(false)
  const msgsRef = useRef<HTMLDivElement | null>(null)
  const posRef = useRef({ x: 0, y: 0, drag: false, offX: 0, offY: 0 })
  const winRef = useRef<HTMLDivElement | null>(null)
  const atTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const activeSid = active?.sessionId ?? ''

  /* ── 打开/切换：面板按钮事件 ── */
  useEffect(() => {
    const onOpen = (ev: Event): void => {
      const detail = (ev as CustomEvent).detail as { target: string; itemKey?: string; title?: string; sendRead?: boolean; parent?: string; cwd?: string }
      setHidden(false)
      if (detail.target === 'paper' && detail.itemKey) {
        void openPaper(detail.itemKey, detail.title ?? '', detail.parent ?? '', detail.cwd ?? '', detail.sendRead ?? false)
      } else if (detail.target === 'library') {
        void openLibrary(detail.parent ?? '', detail.cwd ?? '')
      }
    }
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_EVENT, onOpen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── History 列表轮询（5s） ── */
  useEffect(() => {
    const load = (): void => {
      void apiGet('/chat-sessions').then((r) => {
        setPapers(r.papers ?? [])
        setLibrary(r.library ?? null)
      }).catch(() => {})
    }
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])

  /* ── 消息轮询（1.2s） ── */
  useEffect(() => {
    if (!activeSid) { setMessages([]); return }
    const load = (): void => {
      void apiGet(`/chat-messages?sessionId=${encodeURIComponent(activeSid)}`).then((r) => setMessages(r.messages ?? [])).catch(() => {})
    }
    load()
    const t = setInterval(load, 1200)
    return () => clearInterval(t)
  }, [activeSid])

  /* ── 模型目录（一次） ── */
  useEffect(() => {
    void apiGet('/chat-models').then((r) => {
      const opts: ModelOption[] = []
      for (const p of r.providers ?? []) {
        for (const m of p.models ?? []) {
          opts.push({ provider: p.id, model: m.id, name: m.name || m.id })
        }
      }
      setModels(opts)
      const cur = r.current
      if (cur?.provider && cur?.model) setCurrentModel(`${cur.provider} / ${cur.model}`)
    }).catch(() => {})
  }, [])

  /* 新消息 → 自动滚底（仅当用户接近底部）。 */
  useEffect(() => {
    const el = msgsRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 200
    if (near) el.scrollTop = el.scrollHeight
  }, [messages])

  async function openPaper(itemKey: string, title: string, parent: string, cwd: string, sendRead: boolean): Promise<void> {
    setBooting(true)
    setNote('')
    try {
      const r = await apiPost('/chat-open', { itemKey, title, parent, cwd, sendRead })
      setBooting(false)
      if (!r.ok) { setNote(`⚠️ ${r.error ?? '打开失败'}`); return }
      setActive({ kind: 'paper', itemKey, title: title || itemKey, sessionId: r.sessionId })
      setChips([{ itemKey, title: title || itemKey, mode: 'pdf' }])
      if (r.chars) setNote(`✅ 已载入论文上下文（${r.chars} 字符）。${sendRead ? '已发送精读指令，模型正在阅读…' : ''}`)
      await apiGet('/chat-sessions').then((x) => { setPapers(x.papers ?? []); setLibrary(x.library ?? null) }).catch(() => {})
    } catch (err: any) {
      setBooting(false)
      setNote(`⚠️ ${String(err?.message ?? err)}`)
    }
  }

  async function openLibrary(parent: string, cwd: string): Promise<void> {
    setBooting(true)
    setNote('')
    try {
      const r = await apiPost('/chat-open-library', { parent, cwd })
      setBooting(false)
      if (!r.ok) { setNote(`⚠️ ${r.error ?? '打开失败'}`); return }
      setActive({ kind: 'library', title: '文献库对话', sessionId: r.sessionId })
      setChips([])
      await apiGet('/chat-sessions').then((x) => { setPapers(x.papers ?? []); setLibrary(x.library ?? null) }).catch(() => {})
    } catch (err: any) {
      setBooting(false)
      setNote(`⚠️ ${String(err?.message ?? err)}`)
    }
  }

  async function send(textArg?: string, chipsArg?: PaperChip[]): Promise<void> {
    const text = (textArg ?? input).trim()
    const useChips = chipsArg ?? chips
    if (!text || !active || sending) return
    setSending(true)
    setInput('')
    setAtOpen(false)
    const r = await apiPost('/chat-send', {
      sessionId: active.sessionId,
      text,
      papers: useChips.map((c) => ({ itemKey: c.itemKey, mode: c.mode })),
    })
    setSending(false)
    if (!r.ok) setNote(`⚠️ ${r.error ?? '发送失败'}`)
  }

  /** @论文 chips 操作（原版：左键=发送 PDF；右键=切换 全文/检索）。 */
  function chipLeftClick(chip: PaperChip): void {
    const pdf = { ...chip, mode: 'pdf' as const }
    setChips((cs) => cs.map((c) => (c.itemKey === chip.itemKey ? { ...c, mode: 'pdf' } : c)))
    void send(`请阅读这篇论文（PDF 全文已附）：\n${chip.title}\n请给出结构化精读。`, [pdf])
  }

  function chipToggleMode(chip: PaperChip): void {
    setChips((cs) => cs.map((c) =>
      c.itemKey === chip.itemKey ? { ...c, mode: c.mode === 'pdf' ? 'meta' : 'pdf' } : c,
    ))
  }

  function chipRemove(chip: PaperChip): void {
    setChips((cs) => cs.filter((c) => c.itemKey !== chip.itemKey))
  }

  /* @ 弹层：防抖检索 */
  function onInputChange(v: string): void {
    setInput(v)
    const idx = v.lastIndexOf('@')
    if (idx >= 0 && v.length - idx <= 30) {
      const q = v.slice(idx + 1).split(/[\s@]/)[0]
      setAtOpen(true)
      setAtQuery(q)
      if (atTimer.current) clearTimeout(atTimer.current)
      atTimer.current = setTimeout(() => {
        void apiGet(`/paper-picker?q=${encodeURIComponent(q)}`).then((r) => {
          setAtItems(r.items ?? [])
          setAtOpen(true)
        }).catch(() => setAtItems([]))
      }, 300)
    } else {
      setAtOpen(false)
    }
  }

  function pickPaper(item: { key: string; title: string }): void {
    setChips((cs) => {
      if (cs.some((c) => c.itemKey === item.key)) return cs
      return [...cs, { itemKey: item.key, title: item.title || item.key, mode: 'meta' }]
    })
    // 去掉输入中的 @xxx 片段
    const idx = input.lastIndexOf('@')
    setInput(idx >= 0 ? input.slice(0, idx) : input)
    setAtOpen(false)
    setAtQuery('')
    setAtItems([])
  }

  /* ── 模型选择 ── */
  async function onModelChange(val: string): Promise<void> {
    if (!active || !val) return
    const [provider, model] = val.split(' / ')
    if (!provider || !model) return
    setModelBusy(true)
    const r = await apiPost('/chat-select-model', { sessionId: active.sessionId, provider, model })
    setModelBusy(false)
    if (r.ok) {
      setCurrentModel(val)
      setNote('✅ 已切换模型（下一轮生效）')
    } else {
      setNote(`⚠️ ${r.error ?? '切换失败'}`)
    }
  }

  async function deleteHistory(kind: 'paper' | 'library', itemKey?: string): Promise<void> {
    const r = await apiPost('/chat-history-delete', { kind, itemKey })
    setPapers(r.papers ?? [])
    setLibrary(r.library ?? null)
    if (kind === 'library' && active?.kind === 'library') setActive(null)
    if (kind === 'paper' && active?.itemKey === itemKey) {
      setActive(null)
      setChips([])
    }
  }

  /* ── 拖拽 ── */
  function startDrag(ev: ReactMouseEvent): void {
    const win = winRef.current
    if (!win) return
    const rect = win.getBoundingClientRect()
    posRef.current.drag = true
    posRef.current.offX = ev.clientX - rect.left
    posRef.current.offY = ev.clientY - rect.top
    const move = (e: MouseEvent): void => {
      if (!posRef.current.drag || !winRef.current) return
      winRef.current.style.left = `${e.clientX - posRef.current.offX}px`
      winRef.current.style.top = `${Math.max(8, e.clientY - posRef.current.offY)}px`
    }
    const up = (): void => {
      posRef.current.drag = false
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  const isPaper = active?.kind === 'paper'
  const paperTitle = isPaper ? (active?.title ?? '') : (active ? '文献库对话' : '')
  const welcomeTip = isPaper ? '论文对话回答关于当前活跃论文的问题，模型将在提问前预加载论文上下文。' : '文献库对话回答全库问题：模型会用 zotero_* 工具检索、深读并给出有据可查的回答。'
  return (
    <div ref={winRef} className="dshz dshz-win" data-hidden={hidden ? '1' : '0'} style={{ left: 'auto', right: 16, top: 64, width: 680, height: 'min(70vh, 660px)' }}>
      <style>{CSS}</style>
      <div className="dshz-win-head" onMouseDown={startDrag}>
        <span style={{ fontSize: 13 }}>🧠</span>
        <b>Zotero 文献聊天</b>
        <span style={{ flex: 1 }} />
        <button className="dshz-btn" onClick={() => setHidden(true)} title="最小化">—</button>
        <button className="dshz-btn" onClick={() => setHidden(true)} title="关闭（会话保留）">✕</button>
      </div>
      {/* ── 顶栏：论文标题 + Paper/库 分段切换（原版样式） ── */}
      <div className="dshz-wt">
        <span className="dshz-ttl" title={paperTitle}>{paperTitle || '选择会话…'}</span>
        <div className="dshz-seg">
          <button
            className={isPaper ? 'on' : ''}
            onClick={() => {
              if (active?.kind === 'paper') return
              const p = active?.itemKey || papers[0]?.itemKey
              if (p) void openPaper(p, active?.title ?? papers[0]?.title ?? '', '', '', false)
            }}
          >Paper chat</button>
          <button
            className={active?.kind === 'library' ? 'on' : ''}
            onClick={() => { if (active?.kind === 'library') return; void openLibrary('', '') }}
          >文献库对话</button>
        </div>
      </div>
      <div className="dshz-win-body">
        {/* History 侧栏 */}
        <div className="dshz-win-side">
          <div
            className={`side-item ${active?.kind === 'library' ? 'on' : ''}`}
            onClick={() => void openLibrary('', '')}
          >
            <span className="side-txt">📚 文献库对话</span>
            {library ? (
              <button className="side-del" title="从列表移除" onClick={(e) => { e.stopPropagation(); void deleteHistory('library') }}>🗑</button>
            ) : null}
          </div>
          <div style={{ padding: '4px 8px', fontSize: 10, color: 'var(--dshz-dim)', borderBottom: '1px solid #262a30' }}>
            论文会话（{papers.length}）
          </div>
          {papers.map((p) => (
            <div
              key={p.itemKey}
              className={`side-item ${active?.kind === 'paper' && active.itemKey === p.itemKey ? 'on' : ''}`}
              onClick={() => void openPaper(p.itemKey, p.title, '', '', false)}
              title={p.title}
            >
              <span className="side-txt">📄 {p.title.slice(0, 22)}{p.title.length > 22 ? '…' : ''}</span>
              <button
                className="side-del"
                title="从列表移除（会话数据保留）"
                onClick={(e) => { e.stopPropagation(); void deleteHistory('paper', p.itemKey) }}
              >🗑</button>
            </div>
          ))}
          {papers.length === 0 ? (
            <div style={{ padding: '6px 8px', fontSize: 10.5, color: 'var(--dshz-dim)' }}>还没有论文会话 — 在右侧「Zotero」面板点开一篇论文即可</div>
          ) : null}
        </div>
        {/* 会话主区 */}
        <div className="dshz-win-main">
          {booting ? <div className="dshz-banner ok" style={{ margin: 6 }}>⏳ 激活会话/加载上下文…</div> : null}
          {note ? <div className="dshz-banner ok" style={{ margin: 6 }}>{note}</div> : null}
          {/* @论文 chips 行 */}
          {chips.length > 0 ? (
            <div className="dshz-chips">
              {chips.map((c) => (
                <span
                  key={c.itemKey}
                  className="dshz-chip"
                  title="左键=发送 PDF 全文；右键=切换 全文/元数据；×=移除"
                  onClick={() => chipLeftClick(c)}
                  onContextMenu={(e) => { e.preventDefault(); chipToggleMode(c) }}
                >
                  📄 {c.title.slice(0, 26)}{c.title.length > 26 ? '…' : ''}
                  <span className="mode">{c.mode === 'pdf' ? '全文' : '元数据'}</span>
                  <button className="x" title="移除" onClick={(e) => { e.stopPropagation(); chipRemove(c) }}>×</button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="dshz-chat-msgs" ref={msgsRef}>
            {!active ? <div className="dshz-null">从左侧选择一个会话，或在面板中打开一篇论文</div> : null}
            {active && messages.length === 0 ? (
              <div className="dshz-welcome">
                <h2>Zotero 文献聊天</h2>
                <p>从这里开始，读懂论文的一切。</p>
                <p>{welcomeTip}</p>
                <p>内联上下文：文本、<b>@论文</b>（发消息自动附带；标签<b>左键</b>=发送 PDF、<b>右键</b>=切换全文/元数据）。</p>
              </div>
            ) : null}
            {messages.map((m, idx) => {
              if (m.kind === 'tool') {
                const icon = m.running ? '⏳' : m.ok === false ? '✗' : m.ok === true ? '✓' : '·'
                return (
                  <div key={idx} className="dshz-msg">
                    <div className="who">⚙ <b>{m.name}</b> {icon}{m.running ? ' …' : ''}</div>
                  </div>
                )
              }
              return (
                <div key={idx} className={`dshz-msg ${m.kind === 'user' ? 'user' : ''}`}>
                  <div className="who">{m.kind === 'user' ? '你' : '文献助手'}</div>
                  <div className={`bubble ${m.kind === 'assistant' && m.running ? 'run' : ''}`}>{m.text}</div>
                </div>
              )
            })}
          </div>
          <div className="dshz-pills">
            {(isPaper ? PAPER_PILLS : LIBRARY_PILLS).map((p) => (
              <button key={p.label} className="dshz-btn" disabled={!active || sending} onClick={() => void send(p.text)}>{p.label}</button>
            ))}
            {isPaper ? (
              <button className="dshz-btn" disabled={!active || sending} onClick={() => active && active.itemKey && void openPaper(active.itemKey, active.title, '', '', false)}>重新载入全文</button>
            ) : null}
          </div>
          {/* 输入行（含 @ 弹层） */}
          <div className="dshz-inputrow">
            <div className="dshz-inputwrap">
              <input
                className="dshz-input"
                placeholder={isPaper ? `询问关于《${(active?.title ?? '').slice(0, 24)}…》的问题，@ 添加论文…` : '询问库内文献… @ 添加论文，Enter 发送'}
                value={input}
                disabled={!active}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) void send() }}
              />
              {atOpen ? (
                <div className="dshz-pop">
                  {atItems.length === 0 ? <div className="pop-item" style={{ color: 'var(--dshz-dim)' }}>{atQuery ? `未找到“${atQuery}”相关论文` : '输入关键词检索论文…'}</div> : null}
                  {atItems.map((it) => (
                    <div key={it.key} className="pop-item" onClick={() => pickPaper(it)}>
                      {it.title.slice(0, 60)}{it.title.length > 60 ? '…' : ''}
                      <div className="m">{it.itemType ?? ''}{it.year ? ` · ${it.year}` : ''}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <button className="dshz-btn primary" disabled={sending || !active || !input.trim()} onClick={() => void send()}>
              {sending ? '…' : '发送'}
            </button>
          </div>
          {/* 模型行 */}
          <div className="dshz-model-row">
            <label>模型</label>
            <select
              value={currentModel}
              disabled={!active || models.length === 0 || modelBusy}
              onChange={(e) => void onModelChange(e.target.value)}
            >
              {models.length === 0 ? <option value="">加载中…</option> : null}
              {models.map((m) => (
                <option key={`${m.provider}/${m.model}`} value={`${m.provider} / ${m.model}`}>
                  {m.name}{m.provider !== 'deepseek' ? ` (${m.provider})` : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  )
}
