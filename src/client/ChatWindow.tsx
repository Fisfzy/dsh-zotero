/**
 * dsh-zotero — 独立浮动文献聊天窗（M3.2 rev2）。
 *
 * 形态：position:fixed 独立 React root（挂在 document.body，apply 时创建），
 * 不占面板 tab。左侧 History（文献库对话 + 每篇论文一个会话），右侧会话区
 * （消息流 + pills + 输入框）。面板按钮 dispatch 'dshz:chat-open' 事件：
 *   detail: { target:'paper', itemKey, title } | { target:'library' }
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

const PAPER_PILLS: Array<{ label: string; text: string }> = [
  { label: '概述', text: '请用中文概述这篇论文：核心问题、主要方法、关键结果（带数字）、作者解读。' },
  { label: '要点', text: '请列出这篇论文的 Key Points（每个要点 1-2 句，按重要性排序）。' },
  { label: '方法', text: '请详细说明论文的方法：公式/模型/实验设置，以及每一步的作用。' },
  { label: '局限', text: '请指出论文的局限（原文明确的 + 你的推断，并注明区分）。' },
  { label: '读全文', text: '请通读全文并给出结构化精读：一句话主线 + 章节要点 + 3 个可追问问题。' },
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
  const msgsRef = useRef<HTMLDivElement | null>(null)
  const posRef = useRef({ x: 0, y: 0, drag: false, offX: 0, offY: 0 })
  const winRef = useRef<HTMLDivElement | null>(null)

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

  /* 新消息 → 自动滚底（仅当用户接近底部）。 */
  useEffect(() => {
    const el = msgsRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 160
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
      await apiGet('/chat-sessions').then((x) => { setPapers(x.papers ?? []); setLibrary(x.library ?? null) }).catch(() => {})
    } catch (err: any) {
      setBooting(false)
      setNote(`⚠️ ${String(err?.message ?? err)}`)
    }
  }

  /** 打开面板时自动发一条开场消息（仅库会话首次）。 */
  async function introLibrary(): Promise<void> {
    if (!active || active.kind !== 'library') return
    const r = await apiPost('/chat-send', { sessionId: active.sessionId, text: '你好！请先简单介绍你能做什么，并给我 3 个可立即使用的示例问题。' })
    if (!r.ok) setNote(`⚠️ ${r.error ?? '发送失败'}`)
  }

  async function send(textArg?: string): Promise<void> {
    const text = (textArg ?? input).trim()
    if (!text || !active || sending) return
    setSending(true)
    setInput('')
    const r = await apiPost('/chat-send', { sessionId: active.sessionId, text })
    setSending(false)
    if (!r.ok) setNote(`⚠️ ${r.error ?? '发送失败'}`)
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
  return (
    <div ref={winRef} className="dshz dshz-win" data-hidden={hidden ? '1' : '0'} style={{ left: 'auto', right: 16, top: 64, width: 660, height: 'min(68vh, 640px)' }}>
      <style>{CSS}</style>
      <div className="dshz-win-head" onMouseDown={startDrag}>
        <span style={{ fontSize: 13 }}>🧠</span>
        <b>Zotero 文献聊天</b>
        <span style={{ flex: 1 }} />
        <button className="dshz-btn" onClick={() => setHidden(false)} disabled={!hidden} style={{ display: hidden ? 'inline-block' : 'none' }}>恢复</button>
        <button className="dshz-btn" onClick={() => setHidden(true)} title="最小化">—</button>
        <button className="dshz-btn" onClick={() => setHidden(true)} title="关闭（会话保留）">✕</button>
      </div>
      <div className="dshz-win-body">
        {/* History 侧栏 */}
        <div className="dshz-win-side">
          <div
            className={`side-item ${active?.kind === 'library' ? 'on' : ''}`}
            onClick={() => void openLibrary('', '')}
          >
            📚 文献库对话
            {library?.injectedAt ? <div style={{ fontSize: 10, color: 'var(--dshz-dim)' }}>{new Date(library.injectedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div> : null}
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
              📄 {p.title.slice(0, 24)}{p.title.length > 24 ? '…' : ''}
            </div>
          ))}
          {papers.length === 0 ? (
            <div style={{ padding: '6px 8px', fontSize: 10.5, color: 'var(--dshz-dim)' }}>还没有论文会话 — 在右侧「Zotero」面板点开一篇论文即可</div>
          ) : null}
        </div>
        {/* 会话主区 */}
        <div className="dshz-win-main">
          <div style={{ padding: '4px 8px', borderBottom: '1px solid var(--dshz-line)', fontSize: 11.5, color: 'var(--dshz-dim)', display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className="dshz-badge">{isPaper ? '📄 论文' : '📚 文献库'}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {active?.title ?? '（未选择会话）'}
            </span>
            {active ? <button className="dshz-btn" onClick={() => void (active.kind === 'library' ? introLibrary() : void 0)} style={{ display: active.kind === 'library' ? undefined : 'none' }}>开场白</button> : null}
          </div>
          {booting ? <div className="dshz-banner ok" style={{ margin: 6 }}>⏳ 激活会话/加载上下文…</div> : null}
          {note ? <div className="dshz-banner ok" style={{ margin: 6 }}>{note}</div> : null}
          <div className="dshz-chat-msgs" ref={msgsRef}>
            {!active ? <div className="dshz-null">从左侧选择一个会话，或在面板中打开一篇论文</div> : null}
            {active && messages.length === 0 ? <div className="dshz-null">还没有消息 — 用下方快捷操作或直接输入问题</div> : null}
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
          <div className="dshz-inputrow">
            <input
              className="dshz-input"
              placeholder={isPaper ? `询问关于《${(active?.title ?? '').slice(0, 24)}…》的问题…` : '询问库内文献… Enter 发送'}
              value={input}
              disabled={!active}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) void send() }}
            />
            <button className="dshz-btn primary" disabled={sending || !active || !input.trim()} onClick={() => void send()}>
              {sending ? '…' : '发送'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
