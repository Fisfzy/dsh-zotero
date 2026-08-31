# 文献 CHAT 文档处理机制与 RAG 现状研习

> 2026-08-30 逐行走查 `src/panel-api.ts`（会话/注入/发送）、`src/tools-m2.ts`（读取/总结工具）、
> `src/index.ts`（事件订阅）、`src/config.ts`（开关）。
> 结论先行：**文献 CHAT 的文档处理 =「上下文注入 + 工具按需读取」双通道；真正的库级 RAG 未完成**——
> `ragEnabled` 只是占位开关（默认 false），检索仅覆盖「Zotero 内置全文检索 + 章节词频打分 + 关键词重叠」三处轻量能力。
> 上游对比与移植路线见 **`docs/retrieval-diff.md`**。

---

## 一、文献 CHAT 会话模型

两种会话（`ChatSessionStore`，`cacheDir/chat-sessions.json` 持久化）：

| 会话 | sessionId | 文档处理方式 |
|---|---|---|
| **论文会话**（每篇可多实例） | `zotero-paper-<itemKey>[-<seq>]` | 打开时注入论文上下文；发送 `@` 引用时逐个注入 |
| **文献库会话**（通用） | `zotero-library`（多实例 `-<seq>`） | 只注入库级引导 prompt；文档全靠模型按需工具读取 |

激活统一走 `ensureLiveAgent`：GUI 同款 `sessionController.create`（adopt 全套 agentPreset/workspace/loop）
→ `agents.get` 取 live → 兜底 `agents.create` / `agents.resume`；并 `grantFullAccess` + `restrictTools`
（文献会话工具被限定，避免污染）。

## 二、文档如何进入对话（注入通道）

### 论文会话 `openPaperChatSession`（POST /chat-open）

1. 构建上下文 `buildPaperContext`（见下）→ `agent.inject({content:[{type:'text',text}], source:{kind:'plugin'}})`。
2. **只在 `!conv.injectedAt || body.force` 时注入**——同一实例复用不重复注入；`body.sendRead` 追加 `READ_PROMPT`（开读精读指令）。
3. `chars` 返回字符数（前端显示「全文已注入 N 字符」）。

### `buildPaperContext` 的三种模式（核心）

```
【Zotero 文献上下文 · dsh-zotero 面板注入】
- 标题 / 作者 / 年份 / 期刊 / DOI / URL / 标签 / Zotero key
  （key 行附指导文：可调 zotero_read_fulltext 读全文——先免参拿 sections 再按 offset 精读）
- 摘要（前 1200 字符）
[mode=qa 时追加]【全文节选（缓存文本）】parsed.md.slice(0, max(fullTextTokenBudget*2, 8000))
```

| mode | 触发 | 注入内容 |
|---|---|---|
| `meta`（默认） | 打开会话、`@` 引用 mode=meta | 元数据 + 摘要 + 「如何用工具读全文」的指导 |
| `qa` | `sendRead` 开读、`@` 引用 mode=pdf | meta + **全文头部节选**（截断注入，非检索） |
| 库模式 | /chat-open-library | 仅 `LIBRARY_MODE_PROMPT`（引导模型按工具读库） |

> ⚠️ `qa` 注入的是**开头固定窗口**（预算取 `fullTextTokenBudget*2` 字符，默认 40000+ 字符），
> 不经过任何相关性排序——这是「全文预注入」，不是检索召回。模型只能依赖头部内容 + 工具补读。

### 发送时 `@` 引用（POST /chat-send）

`body.papers[]` 最多 4 篇，`mode==='pdf'→qa`（注入全文节选）、否则 `meta`，逐个 `injectText` 后再发消息。
每篇注入独立段落，模型可从多篇上下文做对比。

## 三、文档如何被读取（工具通道，模型自主选择）

注入文本只给了元数据 + 头部节选；正文细节靠模型调用这 4 个工具按需获取：

| 工具 | 读取方式 |
|---|---|
| `zotero_read_fulltext` | 磁盘缓存全文（MinerU/pdftotext）**免参拿 sections 章节偏移** → `offset/limit` 逐章精读（8k/次，上限 20k）；`query` 走章节打分定位 |
| `zotero_read_pdf` | 只回结构（章节标题 + 字符数 + 预览 3000），不读正文 |
| `zotero_summarize` | overview/targeted/deep × brief/standard/deep；targeted 用 `buildWindow` 定位相关章节后让 LLM 总结 |
| `zotero_translate` | 全文窗口翻译（保留 Markdown/公式/数字） |

### 轻量检索原语：`buildWindow`（tools-m2.ts ~L214）

```
query terms → splitSections 按标题层级切章 → 每章词频打分（terms 出现次数求和）
→ 取 score≥1 的 top 5 章（按原文顺序）→ 拼窗口（≤ budget 字符）；无命中则回退头部窗口
```

- **本质**：章节级词频（term-frequency）排序，无 tf-idf/BM25 归一化、无倒排索引、无 embedding。
- 为 `zotero_read_fulltext.query` 与 `zotero_summarize(targeted)` 复用；是当前最接近「检索」的机制。

### 库级检索：`zotero_library_search`

- `qmode=everything` 时走 **Zotero 内置全文索引**（Zotero 进程自身维护的 fulltext index），
  经 Local API 透传关键词查询——这只算「借用外部索引」，本插件零索引管线。

## 四、RAG 现状审计（直接回答「做好了么」）

**结论：没做好——准确说是「只有开关，没有管线」。**

| 检查项 | 现状 | 证据 |
|---|---|---|
| `ragEnabled` | 存在但 **default false**，注释 *"Library-level RAG (M4; keep off until the index pipeline is enabled)"* | `src/config.ts:60-61,91` |
| 索引构建 | ❌ 无（没有构建 fulltext/BM25/向量索引的代码） | 全局 grep 无 index/BM25/embedding 管线 |
| 检索服务 | ❌ 无独立 retrieval service | — |
| 检索召回点 | 3 处轻量：Zotero fulltext API（外借）、`buildWindow` 章节词频、`zotero_related` 标题/摘要重叠 | 见上 |
| 查询改写 | ❌ 无（上游 `retrievalQueryPlan.ts` 的「同语言变体/缩写/notation variants」改写未移植） | — |
| 分块策略 | 仅 `fulltranslate.ts` 为翻译分块（段落边界）；CHAT 侧无固定 chunk 索引 | — |

**现有能力 vs 真 RAG 的差距**：

- 单篇内：`buildWindow` 关键词定位 **≈ 最简单的检索增强**，但无归一化打分、无跨篇复用索引，每次全量扫内存 MD。
- 库级：只能靠 Zotero 索引做关键词搜索，**无法做语义/向量检索**，也无法跨库「相关段落」召回。
- 论文分析工具（`zotero_review`/`zotero_related`）降级用元数据/关键词，不读全文索引。

## 五、上游资产对照（M0 审计 §3.3 已识别，尚未移植）

llm-for-zotero 的检索资产本可直接搬：

| 上游文件 | 内容 | 移植状态 |
|---|---|---|
| `contextPanel/constants.ts` | CHUNK_TARGET=2000 字符、OVERLAP=200、perPaperTopK=4、topK=6 | ❌ 未移植 |
| `services/retrievalService.ts` | evidence cache key（小写+去标点+120 截断）、score 降序 | ❌ 未移植 |
| `contextPanel/retrievalQueryPlan.ts` | LLM 改写 query：同语言变体、翻译/缩写/notation variants | ❌ 未移植 |
| `pdfContext.ts` | `splitIntoChunks`（段落边界 2000 字）+ `splitMarkdownIntoChunks`（按标题切，保留结构） | ❌ 未移植 |

## 六、落地建议（M4 RAG 的最小可行方案）

1. **索引**：daemon 预解析（timer 扫库 + MinerU 缓存）已有矿 —— 直接在
   `cache/mineru/<key>/full.md` 上构建**章节级倒排索引**（标题为 doc 粒度，BM25 打分，JSON 落盘 `cacheDir/rag-index/`）。
   复用 `splitSections` 切章逻辑，零新依赖。
2. **检索工具**：新增 `zotero_retrieve`（query → BM25 召回 top-k 章节 → 返回段落 + 页码/章节引用），
   供 LIBRARY_MODE 与论文会话使用；`ragEnabled=true` 时注入通道改为「检索 → 注入命中段落」而非头部截断。
3. **查询改写（可选）**：移植上游 `retrievalQueryPlan` prompt（LLM 生成同语言变体 + 术语变体），改善召回。
4. **语义升级（更远期）**：复用环境内 zotero-wave-rag 的 BM25/图传播引擎（README 已声明分工边界），
   或接 DSH 模型适配器做 embedding（配置项开关，保持零硬依赖）。
5. **开读体验变化**：`qa` 从「注入 4 万字符头部」改为「注入元数据 + ragEnabled 时注入检索小节」，
   显著降 token、提相关性（需用户确认——当前「全文已注入」是用户看得见的卖点）。

## 七、一句话总结

> CHAT 现在是 **「全文头部预注入 + 工具按需精读」的 agentic 阅读**,不是 RAG——
> 检索件只有零散的章节词频与 Zotero 外借全文搜索。M4 把 `ragEnabled` 做实 = 
> 在 MinerU 缓存上建章节级 BM25 倒排 + `zotero_retrieve` 工具 + 注入通道改检索召回。