/**
 * dsh-zotero — M2 model-facing tools: PDF 全文阅读 / 文献总结 / 翻译.
 *
 * zotero_read_pdf   附件 → MinerU（cloud/local）→ 缓存 → 结构化返回（含章节与预览）
 * zotero_summarize  全文窗口 → DSH LLM（复用模型适配器+默认模型）→ 概述/定向总结
 * zotero_translate  （节选文本 | 全文窗口）→ DSH LLM 翻译
 *
 * 解析失败时自动降级 pdftotext（环境已装），并在结果 source 标注。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type LlmService from '@deepseek-ai/dsh-llm'
import type { Config } from './config.ts'
import { MineruClient, MineruError } from './mineru/client.ts'
import { attachmentCacheDir, readCachedMd, writeCache } from './mineru/cache.ts'
import { fetchAttachmentPdf } from './zotero/pdf.ts'
import type { ZoteroClient } from './zotero/client.ts'
import { resolveModel, streamText } from './ml.ts'
import type { ResolvedModel } from './ml.ts'
import { currentConfig } from './runtime.ts'

const renderJson = (_args: unknown, value: unknown) => [
  { type: 'text' as const, text: JSON.stringify(value, null, 2) },
]

const DEFAULT_SUMMARY_PROMPT = `你是文献精读助手。基于用户提供的论文全文（MinerU/pdftotext 提取，可能含版式噪声、错字、乱序），回答用户的阅读请求。

规则（源自 llm-for-zotero 的阅读纪律，务必遵守）：
- 回答要“有据可查”：结论落在原文之上，不要编造作者没有的观点、数据、数字。
- 区分“原文直接陈述”和“你的归纳/推断”：推断部分明确说明是你的解读。
- 引用原文关键句时保留原文语言，如需翻译放到引文之外。
- 输出用中文（除非用户指明其它语言）；先给结论，再给支撑。
- 若全文片段不足以回答（如只看到摘要），明确说明覆盖范围与局限。`

const DEFAULT_TRANSLATE_PROMPT = `你是学术文献翻译助手。把用户提供的文献文本翻译为目标语言：
- 忠实于原文语义与术语；公式/代码/符号保持原样；数字不得改动。
- 保留 Markdown 结构（标题层级、列表、引用块标记）。
- 只输出译文本身，不要附加解释或“以下是翻译”之类的开头。`

/** Error projection helper: domain outcomes in canonical values. */
function domainError(err: unknown): { error: string; hint: string } {
  if (err instanceof MineruError) {
    return { error: err.message, hint: err.hint ?? '请检查 MinerU 配置或改用本机 pdftotext 降级' }
  }
  const e = err as { message?: string; hint?: string }
  return { error: String(e?.message ?? err), hint: e?.hint ?? '' }
}

interface ParsedPaper {
  attachmentKey: string
  title: string
  md: string
  source: string
  cacheDir: string
  textChars: number
}

/** Resolve item → PDF attachment → (cache | parse) → markdown. */
export async function ensureParsed(
  client: ZoteroClient,
  _cfg: Config,
  mode: 'auto' | 'mineru' | 'text',
  itemKey: string,
  attachmentKey?: string,
  exec?: { signal?: AbortSignal },
): Promise<ParsedPaper> {
  const cfg = currentConfig()
  const got = await client.scoped(exec?.signal).getItem(itemKey)
  if (!got.found || !got.item) {
    throw new Error(`条目不存在: ${itemKey}（${got.error}）`)
  }
  const item = got.item
  const pdfs = item.attachments.filter((a) => a.isPdf)
  const attachment =
    (attachmentKey ? item.attachments.find((a) => a.key === attachmentKey) : undefined) ?? pdfs[0]
  if (!attachment) {
    throw new Error(`条目 ${itemKey} 没有 PDF 附件（共 ${item.attachments.length} 个附件，类型: ${item.attachments.map((a) => a.contentType).join(', ') || '无'}）`)
  }

  const cached = readCachedMd(cfg, attachment.key)
  if (cached && mode !== 'text') {
    return {
      attachmentKey: attachment.key,
      title: item.title || attachment.title,
      md: cached,
      source: 'cache',
      cacheDir: attachmentCacheDir(cfg, attachment.key),
      textChars: cached.length,
    }
  }

  const pdf = await fetchAttachmentPdf(client, attachment.key, cfg, exec?.signal)

  if (mode === 'text') {
    const md = await pdfToText(pdf.bytes)
    const { dir } = writeCache(cfg, attachment.key, md, [], 'pdftotext', 'pdftotext')
    return { attachmentKey: attachment.key, title: item.title || attachment.title, md, source: 'pdftotext', cacheDir: dir, textChars: md.length }
  }

  try {
    const mineru = new MineruClient(cfg)
    const parsed = await mineru.parse({
      pdfBytes: pdf.bytes,
      fileName: pdf.fileName,
      signal: exec?.signal,
    })
    const { dir } = writeCache(cfg, attachment.key, parsed.md, parsed.imageFiles, cfg.mineruMode === 'cloud' ? 'cloud' : cfg.mineruLocalBackend, parsed.source)
    return {
      attachmentKey: attachment.key,
      title: item.title || attachment.title,
      md: parsed.md,
      source: parsed.source,
      cacheDir: dir,
      textChars: parsed.mdChars,
    }
  } catch (err) {
    // MinerU 失败 → pdftotext 降级（显式标注）。
    const md = await pdfToText(pdf.bytes)
    const { dir } = writeCache(cfg, attachment.key, md, [], 'pdftotext', `pdftotext(降级:${domainError(err).error})`)
    return {
      attachmentKey: attachment.key,
      title: item.title || attachment.title,
      md,
      source: `pdftotext(降级:${domainError(err).error})`,
      cacheDir: dir,
      textChars: md.length,
    }
  }
}

/** pdftotext -layout <bytes> - (poppler; present via MiKTeX/TeXLive). */
function pdfToText(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!bytes.length) return reject(new Error('PDF 字节为空'))
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-zotero-'))
    const pdfPath = join(tmp, 'paper.pdf')
    writeFileSync(pdfPath, bytes)
    const child = spawn('pdftotext', ['-layout', pdfPath, '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
    child.on('error', (e) => {
      rmSync(tmp, { recursive: true, force: true })
      reject(new Error(`pdftotext 不可用: ${e.message}`))
    })
    child.on('close', (code) => {
      rmSync(tmp, { recursive: true, force: true })
      if (code !== 0) return reject(new Error(`pdftotext 退出码 ${code}: ${err.slice(0, 160)}`))
      resolve(out.replace(/\r\n/g, '\n').trim())
    })
  })
}

interface Section { title: string; start: number; end: number }

function splitSections(md: string): Section[] {
  const lines = md.split('\n')
  const sections: Section[] = []
  let current: Section | null = null
  let plainStart = 0
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{1,3})\s+(.+)$/.exec(lines[i])
    if (m) {
      if (current) current.end = i
      current = { title: m[2].slice(0, 80), start: i, end: i }
      sections.push(current)
    } else if (!current) {
      plainStart = i
      void plainStart
    }
  }
  if (current) current.end = lines.length
  if (!sections.length) sections.push({ title: '(全文)', start: 0, end: lines.length })
  return sections
}

function textOf(md: string, s: Section): string {
  return md.split('\n').slice(s.start, s.end).join('\n')
}

/** Head window plus (when query given) top matching sections, honoring a char budget. */
function buildWindow(md: string, query: string | undefined, charBudget: number): { text: string; sections: string[] } {
  const budget = Math.max(charBudget, 4000)
  if (!query || !query.trim()) {
    return { text: md.slice(0, budget), sections: splitSections(md).slice(0, 12).map((s) => s.title) }
  }
  const terms = query.split(/\s+/).map((t) => t.toLowerCase()).filter((t) => t.length > 1)
  const sections = splitSections(md)
  const ranked = sections
    .map((s, idx) => {
      const text = textOf(md, s).toLowerCase()
      const score = terms.reduce((acc, t) => acc + (text.includes(t) ? text.split(t).length - 1 : 0), 0)
      return { s, idx, score }
    })
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
  const picked = ranked
    .filter((r) => r.score >= 1)
    .slice(0, 5)
    .sort((a, b) => a.idx - b.idx)
  if (!picked.length) {
    return { text: md.slice(0, budget), sections: sections.slice(0, 12).map((s) => s.title) }
  }
  let text = ''
  for (const { s } of picked) {
    if (text.length >= budget) break
    text += `\n\n## ${s.title}\n${textOf(md, s)}`
  }
  return { text: text.slice(0, budget), sections: picked.map((p) => p.s.title) }
}

export function registerM2Tools(
  ctx: { tools: { register(tool: unknown): void } },
  client: ZoteroClient,
  cfg: Config,
  llm: LlmService,
  agentDefaultModel: { currentSelection(): ResolvedModel } | undefined,
): void {
  /* ── zotero_read_pdf ─────────────────────────────────────────────── */

  ctx.tools.register(
    defineTool({
      name: 'zotero_read_pdf',
      description:
        'Read a paper PDF from the Zotero library: downloads the attachment, parses it with MinerU (local/cloud per config, cached in the plugin cache dir), and returns the full-text markdown structure — total characters, section titles, and a preview window. Use this BEFORE paper QA; zotero_summarize reuses the cache.',
      parameters: {
        itemKey: { type: 'string', required: true, description: 'Zotero item key (paper).' },
        attachmentKey: { type: 'string', description: 'Specific PDF attachment key; default = first PDF attachment.' },
        mode: {
          type: 'string',
          enum: ['auto', 'mineru', 'text'],
          description: "auto = mineru with pdftotext fallback; mineru = MinerU only; text = pdftotext only (fast, low fidelity).",
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            itemKey: { type: 'string', required: true },
            title: { type: 'string', required: true },
            attachmentKey: { type: 'string', required: true },
            source: { type: 'string', required: true },
            textChars: { type: 'integer', required: true },
            sectionTitles: { type: 'array', items: { type: 'string' }, required: true },
            preview: { type: 'string', required: true },
            cacheDir: { type: 'string', required: true },
            images: { type: 'integer', required: true },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      timeoutMs: 300_000,
      execute: async (args, exec) => {
        const a = args as { itemKey: string; attachmentKey?: string; mode?: string }
        try {
          const parsed = await ensureParsed(client, cfg, (a.mode as 'auto' | 'mineru' | 'text') ?? 'auto', a.itemKey, a.attachmentKey, exec)
          const preview = parsed.md.slice(0, 3000)
          return {
            status: 'ok',
            itemKey: a.itemKey,
            title: parsed.title,
            attachmentKey: parsed.attachmentKey,
            source: parsed.source,
            textChars: parsed.textChars,
            sectionTitles: splitSections(parsed.md).slice(0, 20).map((s) => s.title),
            preview,
            cacheDir: parsed.cacheDir,
            images: readImagesCount(parsed),
            error: '',
            hint: '',
          }
        } catch (err: any) {
          const d = { ...domainError(err), status: 'error' as const, itemKey: a.itemKey, title: '', attachmentKey: a.attachmentKey ?? '', source: '', textChars: 0, sectionTitles: [] as string[], preview: '', cacheDir: '', images: 0 }
          return d
        }
      },
      isConcurrencySafe: () => false,
      presentCall: (args) => ({
        card: 'generic',
        title: `读论文: ${String((args as { itemKey?: unknown }).itemKey ?? '')}`,
        kind: 'other',
        rawInput: args,
      }),
    }),
  )

  /* ── zotero_summarize ─────────────────────────────────────────────── */
  ctx.tools.register(
    defineTool({
      name: 'zotero_summarize',
      description:
        'Summarize a paper from the Zotero library using the configured DSH model. mode=overview gives a full summary; mode=targeted answers one specific question/interest (pass query). Grounded in the parsed full text (MinerU cache preferred).',
      parameters: {
        itemKey: { type: 'string', required: true, description: 'Zotero item key (paper).' },
        attachmentKey: { type: 'string' },
        mode: { type: 'string', enum: ['overview', 'targeted'], description: 'overview = whole paper; targeted = answer query.' },
        query: { type: 'string', description: 'For targeted mode: the specific question/interest.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            title: { type: 'string', required: true },
            mode: { type: 'string', required: true },
            summary: { type: 'string', required: true },
            source: { type: 'string', required: true },
            textChars: { type: 'integer', required: true },
            sections: { type: 'array', items: { type: 'string' }, required: true },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      timeoutMs: 600_000,
      execute: async (args, exec) => {
        return runSummary(client, cfg, llm, agentDefaultModel, args as { itemKey: string; attachmentKey?: string; mode?: string; query?: string }, exec)
      },
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: `总结: ${String((args as { itemKey?: unknown }).itemKey ?? '')}`,
        kind: 'other',
        rawInput: args,
      }),
    }),
  )

  /* ── zotero_translate ─────────────────────────────────────────────── */

  ctx.tools.register(
    defineTool({
      name: 'zotero_translate',
      description:
        'Translate literature text: pass `text` directly, or `itemKey` to translate a window of the parsed paper full text. Uses the configured DSH model. Preserves Markdown structure, keeps formulas/numbers untouched.',
      parameters: {
        text: { type: 'string', description: 'Explicit text to translate (wins over itemKey).' },
        itemKey: { type: 'string', description: 'Zotero item key to translate from its parsed full text.' },
        attachmentKey: { type: 'string' },
        targetLang: { type: 'string', required: true, description: 'Target language, e.g. zh-CN, en, ja.' },
        sourceLang: { type: 'string', description: 'Source language hint (auto-detect when omitted).' },
        query: { type: 'string', description: 'Optional focus: translate only the sections about this topic.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            translation: { type: 'string', required: true },
            sourceLang: { type: 'string', required: true },
            targetLang: { type: 'string', required: true },
            chars: { type: 'integer', required: true },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      timeoutMs: 600_000,
      execute: async (args, exec) => {
        const a = args as { text?: string; itemKey?: string; attachmentKey?: string; targetLang: string; sourceLang?: string; query?: string }
        try {
          const c = currentConfig()
          let text: string
          let sourceLabel = '用户提供'
          if (typeof a.text === 'string' && a.text.trim()) {
            text = a.text.trim()
          } else if (a.itemKey) {
            const parsed = await ensureParsed(client, c, 'auto', a.itemKey, a.attachmentKey, exec)
            const budgetChars = Math.max(c.fullTextTokenBudget * 3, 8000)
            text = buildWindow(parsed.md, a.query || undefined, budgetChars).text
            sourceLabel = `《${parsed.title}》(节选, ${parsed.textChars} 字符)`
          } else {
            throw new Error('要么传 text，要么传 itemKey')
          }
          const model = resolveModel(agentDefaultModel)
          const system = c.translatePrompt.trim() || DEFAULT_TRANSLATE_PROMPT
          const user = `源语言: ${a.sourceLang ?? '自动识别'}\n目标语言: ${a.targetLang}\n来源: ${sourceLabel}\n\n待翻译文本：\n---\n${text}\n---`
          const translation = await streamText(llm, model, { system, user, signal: exec.signal, maxTokens: 8192 })
          return {
            status: 'ok',
            translation,
            sourceLang: a.sourceLang ?? 'auto',
            targetLang: a.targetLang,
            chars: text.length,
            error: '',
            hint: '',
          }
        } catch (err: any) {
          const d = { ...domainError(err), status: 'error' as const, translation: '', sourceLang: a.sourceLang ?? 'auto', targetLang: a.targetLang, chars: 0 }
          return d
        }
      },
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: `翻译 → ${String((args as { targetLang?: unknown }).targetLang ?? '')}`,
        kind: 'other',
        rawInput: args,
      }),
    }),
  )
}

function readImagesCount(parsed: ParsedPaper): number {
  try {
    const imgDir = join(parsed.cacheDir, 'images')
    if (!existsSync(imgDir)) return 0
    return readdirSync(imgDir).length
  } catch {
    return 0
  }
}

/** Shared summary orchestration (tool + panel route). */
export async function runSummary(
  client: ZoteroClient,
  _cfg: Config,
  llm: LlmService,
  agentDefaultModel: { currentSelection(): ResolvedModel } | undefined,
  a: { itemKey: string; attachmentKey?: string; mode?: string; query?: string },
  exec?: { signal?: AbortSignal },
): Promise<{
  status: string
  title: string
  mode: string
  summary: string
  source: string
  textChars: number
  sections: string[]
  error: string
  hint: string
}> {
  const cfg = currentConfig()
  try {
    const parsed = await ensureParsed(client, cfg, 'auto', a.itemKey, a.attachmentKey, exec)
    const mode = a.mode === 'targeted' ? 'targeted' : 'overview'
    const query = a.query ?? ''
    const budgetChars = Math.max(cfg.fullTextTokenBudget * 3, 8000)
    const window = buildWindow(parsed.md, mode === 'targeted' && query ? query : undefined, budgetChars)
    const model = resolveModel(agentDefaultModel)
    const system = cfg.summaryPrompt.trim() || DEFAULT_SUMMARY_PROMPT
    const user = mode === 'targeted'
      ? `论文：《${parsed.title}》\n用户问题：${query}\n\n全文节选（相关章节）：\n${window.text}`
      : `论文：《${parsed.title}》\n请按概述模式总结：核心问题（1 句）、主要方法、关键结果（带数字）、局限与作者解读。\n\n全文节选：\n${window.text}`
    const summary = await streamText(llm, model, {
      system,
      user,
      signal: exec?.signal,
      maxTokens: 4096,
    })
    return {
      status: 'ok',
      title: parsed.title,
      mode,
      summary,
      source: parsed.source,
      textChars: parsed.textChars,
      sections: window.sections,
      error: '',
      hint: '',
    }
  } catch (err: any) {
    const d = { ...domainError(err), status: 'error' as const, title: '', mode: (a.mode === 'targeted' ? 'targeted' : 'overview') as string, summary: '', source: '', textChars: 0, sections: [] as string[] }
    return d
  }
}
