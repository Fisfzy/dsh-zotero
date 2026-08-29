/**
 * dsh-zotero — model-facing tools (M1: connection layer).
 *
 * zotero_health          Local/Web API 健康检测与数据源探测
 * zotero_library_search  库检索（元数据 + 可选全文 qmode=everything + tag/collection/itemType 过滤）
 * zotero_get_item        单条目详情（含附件/笔记/批注子项）
 * zotero_collections     收藏夹树（层级展开）
 *
 * 命名说明：环境内 zotero-wave-rag 已注册 zotero_search（语义检索），为避免
 * 同 scope 工具重名（注册即抛错），本插件的 Local API 检索命名为
 * zotero_library_search，并在描述中区分语义检索。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ZoteroClient } from './zotero/client.ts'
import type { Config } from './config.ts'

const renderJson = (_args: unknown, value: unknown) => [
  { type: 'text' as const, text: JSON.stringify(value, null, 2) },
]

/** 按 output schema 递归裁剪返回值（dsh-tools 校验器 strict：未声明字段会被拒）。 */
export function stripBySchema(value: unknown, node: any): any {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) {
    return value.map((v) => stripBySchema(v, node?.items ?? {}))
  }
  if (typeof value === 'object') {
    let props: Record<string, unknown> = {}
    if (Array.isArray(node?.oneOf)) {
      for (const o of node.oneOf) Object.assign(props, o?.properties ?? {})
    } else {
      props = node?.properties ?? {}
    }
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(props)) {
      if (Object.hasOwn(value, k)) out[k] = stripBySchema((value as Record<string, unknown>)[k], props[k])
    }
    return out
  }
  return value
}

const itemSummarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    key: { type: 'string', required: true },
    version: { type: 'integer', required: true },
    itemType: { type: 'string', required: true },
    title: { type: 'string', required: true },
    creators: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          creatorType: { type: 'string', required: true },
          firstName: { type: 'string', required: true },
          lastName: { type: 'string', required: true },
          fullName: { type: 'string', required: true },
        },
      },
    },
    date: { type: 'string', required: true },
    year: { type: 'integer' },
    abstractNote: { type: 'string', required: true },
    doi: { type: 'string', required: true },
    url: { type: 'string', required: true },
    publicationTitle: { type: 'string', required: true },
    journalAbbreviation: { type: 'string', required: true },
    extra: { type: 'string', required: true },
    tags: { type: 'array', items: { type: 'string' }, required: true },
    collections: { type: 'array', items: { type: 'string' }, required: true },
    numChildren: { type: 'integer', required: true },
    numNotes: { type: 'integer', required: true },
    dateAdded: { type: 'string', required: true },
    dateModified: { type: 'string', required: true },
    library: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', required: true },
        id: { type: 'integer', required: true },
        name: { type: 'string' },
      },
    },
    source: { type: 'string', required: true },
  },
} as const

export function registerZoteroTools(ctx: { tools: { register(tool: unknown): void } }, client: ZoteroClient, config: Config): void {
  /* ── zotero_health ─────────────────────────────────────────────────── */

  ctx.tools.register(
    defineTool({
      name: 'zotero_health',
      description:
        'Report whether the Zotero source is reachable and which one: local API (Zotero Desktop HTTP server) or web API (configured fallback). Use it before Zotero tools fail repeatedly, or when the user asks why Zotero data is unavailable.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            source: { type: 'string', required: true },
            localBase: { type: 'string', required: true },
            webUserId: { type: 'string', required: true },
            latencyMs: { type: 'integer', required: true },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      execute: async () => client.health(),
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', title: 'Zotero 连接检测', kind: 'other', rawInput: null }),
    }),
  )

  /* ── zotero_library_search ─────────────────────────────────────────── */

  ctx.tools.register(
    defineTool({
      name: 'zotero_library_search',
      description:
        'Search the Zotero library by metadata (title/creator/year/tags/abstract) or fulltext with qmode=everything, plus tag/collection/itemType filters. Returns normalized item summaries (no PDF bodies). SQLite/Semantic library search is zotero_search (zotero-wave-rag); this tool hits the live Zotero API and reflects the desktop state.',
      parameters: {
        query: {
          type: 'string',
          description:
            'Free-text query. With qmode=everything it also searches the full text of PDFs bound to your items.',
        },
        qmode: {
          type: 'string',
          enum: ['titleCreatorYear', 'everything', 'title', 'creators', 'year', 'tags', 'abstractNote'],
          description:
            'Search mode. everything = fulltext+metadata (slower); default titleCreatorYear.',
        },
        tag: { type: 'string', description: 'Restrict to items carrying this exact tag.' },
        collectionKey: { type: 'string', description: 'Restrict to a collection (its API key, e.g. from zotero_collections).' },
        itemType: { type: 'string', description: 'Zotero item type, e.g. journalArticle, book, conferencePaper.' },
        sort: {
          type: 'string',
          enum: ['dateAdded', 'dateModified', 'title', 'date', 'creator'],
          description: 'Sort field (default dateAdded); Zotero spells it `creator`, not `creators`.',
        },
        direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction (default desc).' },
        limit: { type: 'integer', description: 'Page size, 1-100 (default from config).' },
        start: { type: 'integer', description: 'Offset for pagination.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            source: { type: 'string', required: true },
            total: { type: 'integer', required: true },
            items: { type: 'array', items: itemSummarySchema, required: true },
            qmode: { type: 'string', required: true },
            library: { type: 'string', required: true },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      execute: async (args, exec) => {
        const a = args as Record<string, unknown>
        return client.scoped(exec.signal).search({
          query: typeof a.query === 'string' ? a.query : undefined,
          qmode: typeof a.qmode === 'string' ? a.qmode : undefined,
          tag: typeof a.tag === 'string' ? a.tag : undefined,
          collectionKey: typeof a.collectionKey === 'string' ? a.collectionKey : undefined,
          itemType: typeof a.itemType === 'string' ? a.itemType : undefined,
          sort: typeof a.sort === 'string' ? a.sort : undefined,
          direction: a.direction === 'asc' ? 'asc' : a.direction === 'desc' ? 'desc' : undefined,
          limit: typeof a.limit === 'number' ? a.limit : undefined,
          start: typeof a.start === 'number' ? a.start : undefined,
        })
      },
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: `库检索: ${String((args as { query?: unknown }).query ?? '')}`,
        kind: 'other',
        rawInput: args,
      }),
    }),
  )

  /* ── zotero_get_item ───────────────────────────────────────────────── */

  ctx.tools.register(
    defineTool({
      name: 'zotero_get_item',
      description:
        'Fetch one Zotero item with all its children: attachments (with file download paths), notes, and annotations. Use it after zotero_library_search / zotero_collections to read full metadata, tags, collections or to locate the PDF for further processing.',
      parameters: {
        key: {
          type: 'string',
          required: true,
          description: 'Zotero item key (the `key` field returned by zotero_library_search / zotero_collections).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', required: true },
            source: { type: 'string', required: true },
            item: {
              oneOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    ...itemSummarySchema.properties,
                    attachments: {
                      type: 'array',
                      required: true,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          key: { type: 'string', required: true },
                          title: { type: 'string', required: true },
                          contentType: { type: 'string', required: true },
                          linkMode: { type: 'string', required: true },
                          filename: { type: 'string' },
                          downloadPath: { type: 'string', required: true },
                          isPdf: { type: 'boolean', required: true },
                        },
                      },
                    },
                    notes: {
                      type: 'array',
                      required: true,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          key: { type: 'string', required: true },
                          note: { type: 'string', required: true },
                          title: { type: 'string', required: true },
                        },
                      },
                    },
                    annotations: {
                      type: 'array',
                      required: true,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          key: { type: 'string', required: true },
                          annotationText: { type: 'string', required: true },
                          annotationComment: { type: 'string', required: true },
                          color: { type: 'string', required: true },
                          pageLabel: { type: 'string' },
                        },
                      },
                    },
                  },
                },
                { type: 'null' },
              ],
            },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      execute: async (args, exec) => {
        return client.scoped(exec.signal).getItem(String((args as { key: string }).key ?? ''))
      },
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: `条目: ${String((args as { key?: unknown }).key ?? '')}`,
        kind: 'other',
        rawInput: args,
      }),
    }),
  )

  /* ── zotero_collections ────────────────────────────────────────────── */

  ctx.tools.register(
    defineTool({
      name: 'zotero_collections',
      description:
        'List the Zotero collection tree (nested folders, with item counts and depth). Use it for library browsing, or to resolve a collection name to its key before zotero_library_search(collectionKey=...).',
      parameters: {
        flat: {
          type: 'boolean',
          description:
            'Return the flat list (all collections with parentKey) instead of the nested tree (default false).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            source: { type: 'string', required: true },
            total: { type: 'integer', required: true },
            tree: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  key: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  parentKey: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                  itemCount: { type: 'integer' },
                  depth: { type: 'integer', required: true },
                },
              },
            },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      execute: async (_args, exec) => {
        return client.scoped(exec.signal).collections()
      },
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', title: 'Zotero 收藏夹', kind: 'other', rawInput: null }),
    }),
  )

  void config
}
