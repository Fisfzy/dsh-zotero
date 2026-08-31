/**
 * dsh-zotero — retrieval/service.ts：论文内证据检索服务。
 *
 * 组合 indexer（分块索引）+ rank（BM25/意图/章节 boost/启发式），
 * 供两类消费者复用：
 *   - 工具层 `zotero_retrieve`（模型按需检索章节证据）
 *   - 注入层 buildPaperContext（qa 打开时检索召回证据片段进上下文）
 *
 * 尽力而为的 evidence cache：同论文同查询规范化 key 缓存结果，
 * 避免模型追问时重复检索（对应上游 RetrievalService.evidenceCache）。
 * 索引本身按 attachmentKey 内存缓存（full.md 读取一次、多次检索）。
 */
import { createHash } from 'node:crypto'
import { buildChunkIndex, charOffsetOf, type ChunkIndex } from './indexer.ts'
import { rankEvidenceCandidates } from './rank.ts'

/** 检索服务只依赖解析产物的最小形状（避免与 tools-m2 的 ParsedPaper 直接耦合）。 */
export interface ParsedForRetrieval {
  itemKey?: string
  attachmentKey: string
  title: string
  md: string
}

export interface RetrievedEvidence {
  paperKey: string
  attachmentKey: string
  title: string
  query: string
  intent: string
  /** top 证据块（按序）。 */
  hits: Array<{
    chunkIndex: number
    sectionLabel: string
    text: string
    score: number
    offset: number
    charLen: number
  }>
  /** 本次检索的字符/体积信息（供「是否命中」判断）。 */
  totalChunks: number
  textChars: number
  latencyMs: number
  cached: boolean
}

/** 论文全文（按 attachmentKey）→ 内存索引缓存。 */
const indexCache = new Map<string, ChunkIndex>()
const EVIDENCE_CACHE_LIMIT = 200

/** 规范化查询：小写、去标点、压缩空白、截断 120（上游 buildEvidenceCacheKey 同款）。 */
export function normalizeQueryKey(query: string): string {
  return query.trim().toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
}

function evidenceCacheKey(attachmentKey: string, query: string): string {
  const q = normalizeQueryKey(query)
  if (!q) return ''
  return createHash('sha1').update(`${attachmentKey}\u0000${q}`).digest('hex').slice(0, 16)
}

const evidenceCache = new Map<string, RetrievedEvidence>()

/** 清理缓存（面板「修复缓存」时用；避免 200 条后爆内存）。 */
export function clearRetrievalCaches(): void {
  indexCache.clear()
  evidenceCache.clear()
}

/** 用已解析全文检索证据（不重新解析；解析交给调用方 ensureParsed）。 */
export async function retrieveEvidence(
  parsed: ParsedForRetrieval,
  query: string,
  options: { topK?: number } = {},
): Promise<RetrievedEvidence> {
  const t0 = Date.now()
  const topK = Math.max(1, Math.min(options.topK ?? 5, 12))
  const md = parsed.md ?? ''
  const attachmentKey = parsed.attachmentKey
  const ck = evidenceCacheKey(attachmentKey, query)
  if (ck && evidenceCache.has(ck)) {
    const hit = evidenceCache.get(ck)!
    return { ...hit, cached: true, latencyMs: Date.now() - t0 }
  }

  let index = indexCache.get(attachmentKey)
  if (!index || index.chunks.length === 0) {
    index = buildChunkIndex(md)
    indexCache.set(attachmentKey, index)
  }

  const ranked = rankEvidenceCandidates(index, query, { topK })
  const hits = ranked.map((r) => {
    const offset = charOffsetOf(md, r.meta?.startLine ?? 1)
    return {
      chunkIndex: r.chunkIndex,
      sectionLabel: r.sectionLabel,
      text: r.chunkText,
      score: Math.round(r.bm25Score * 100) / 100,
      offset,
      charLen: r.chunkText.length,
    }
  })

  const result: RetrievedEvidence = {
    paperKey: parsed.itemKey ?? parsed.attachmentKey,
    attachmentKey,
    title: parsed.title,
    query,
    intent: detectIntentLabel(query),
    hits,
    totalChunks: index.chunks.length,
    textChars: md.length,
    latencyMs: Date.now() - t0,
    cached: false,
  }
  if (ck) {
    if (evidenceCache.size >= EVIDENCE_CACHE_LIMIT) {
      const first = evidenceCache.keys().next().value
      if (first !== undefined) evidenceCache.delete(first)
    }
    evidenceCache.set(ck, result)
  }
  return result
}

function detectIntentLabel(query: string): string {
  // 简短导出意图标签，避免 rank.ts 的类型依赖（保持返回纯 JSON）。
  const q = query.toLowerCase()
  if (/\bmethod\b|\bprotocol\b|\balgorithm\b/.test(q)) return 'methodological'
  if (/\bfigure\b|\btable\b|\bdiagram\b|\bcaption\b/.test(q)) return 'visual'
  if (/\bcompar|\bversus\b|\bvs\.?\b|\bcontrast\b/.test(q)) return 'comparative'
  if (/\bcit|\brefer/.test(q)) return 'citation'
  if (/\bhow many\b|\bpercentage\b|\bratio\b|\bcount\b/.test(q)) return 'factual'
  if (/\bmechanism\b|\bwhy does\b|\bhow does\b/.test(q)) return 'conceptual'
  return 'general'
}

/** 单条证据块的渲染文本（带章节/页码前缀，供注入与工具输出）。 */
export function formatEvidenceHit(hit: RetrievedEvidence['hits'][number], budgetChars: number): string {
  const head = hit.sectionLabel ? `## ${hit.sectionLabel}\n` : ''
  const body = hit.text.slice(0, Math.max(800, budgetChars))
  return `${head}${body}`
}