# 文献检索差距研习：llm-for-zotero vs dsh-zotero

> 2026-08-30 浅克隆上游 `yilewang/llm-for-zotero`（commit 2026-08-25）逐层读源码，
> 对照本项目 `src/tools-m2.ts` / `src/panel-api.ts` / `src/tools.ts` 的检索实现。
> **一句话差距：上游是「分层检索 + 证据打包」的完整 RAG 管线，本项目目前是「头部截断注入 + 章节词频粗筛」的轻量做法——中间隔着一整套分块索引、查询改写、混合排序、意图加权与证据引用机制。**

---

## 一、上游检索管线（5 层拆解）

### 第 1 层：分块与索引构建（`modules/contextPanel/pdfContext.ts`，2925 行）

| 机制 | 实现 |
|---|---|
| `splitMarkdownIntoChunks`（L750） | **标题层级切章节**（`#{1,4}`）→ 小章节按预算累积合并 → 大章节按段落切 → 超大段落**句子边界感知切片**（`findSentenceBoundary`：`. ` `? ` `! ` `\n`，±200 字符漂移，避开 "Fig. 2"/"e.g." 缩写）+ **200 字符 overlap**（防切片切断语义） |
| `splitIntoChunks`（L875） | 纯文本（PDFWorker/笔记）同款策略，target=2000 字符 |
| `splitWithManifestSections`（L927） | 用 MinerU manifest 的 section 边界切，再套 markdown 分块 |
| `buildChunkIndex`（L1605） | 每块产出 `tf / uniqueTerms / length`；全局 `docFreq`（prototype-less record）；`avgChunkLength` —— **BM25 所需的全部统计量** |
| chunk 元数据（`buildChunkMetadata` L1427） | sectionLabel / chunkKind（abstract/results/methods/figure-caption…）/ anchorText / pageStart-pageEnd / sourceFingerprint —— **每个候选块都带来源锚点** |

### 第 2 层：查询改写（`contextPanel/retrievalQueryPlan.ts`，767 行）

- **`RetrievalQueryPlan`**：`originalQuery + variants(≤8，默认 6) + effectiveQueries + lexicalTerms + semanticQuery + readIntent + references + notes`。
- `resolveRetrievalQueryPlan`（LLM 调用，10s 超时）：让模型产出查询的同语言变体、翻译/缩写/notation 变体（如 "CNN" ↔ "convolutional neural network" ↔ 中文术语）→ 去重、截断（单变体 160 字符、语义查询 700 字符）。
- `buildRetrievalQueryPlan`（无 LLM 兜底）：变体规范化 + **文档引用解析**（`parseDocumentReferences`：识别 "@Paper" 之类引用 → `buildCanonicalReferenceQuery`）+ `tokenizeRetrievalQuery` 汇总词法 terms。
- **Query Plan 缓存 key**（`buildRetrievalQueryPlanCacheKey`）：同问题变体共享一次改写。

### 第 3 层：排序（`pdfContext.ts` buildPaperRetrievalCandidates L2269 + retrievalService.ts）

单篇内候选打分 = 多信号融合：

1. **BM25 词法分**（`scoreChunkBM25` L1669）：k1=1.2、b=0.75、IDF 平滑 `log(1+(N-df+0.5)/(df+0.5))`。
2. **Embedding 语义分**（`ensureEmbeddings` L1721 + `cosineSimilarity` L1695）：
   - 每块向量预计算（`EMBEDDING_BATCH_SIZE=16` 分批），无向量 provider 时**优雅降级纯词法**（`embeddingFailureKey` 防止反复重试）。
   - 查询向量 `callEmbeddings([semanticQuery])` → 逐块余弦相似度。
   - `preGenerateEmbeddings`（L1841）：多文比较时**后台预生成**，避免首查冷启动。
3. **RRF 融合**（L2399）：`1/(RRF_K + bm25Rank) + 1/(RRF_K + embedRank)`，K=60 —— 不敏感于绝对分值，纯排名融合。
4. **查询意图加权**（`detectQueryIntent` L2127 + `SECTION_BOOST_PROFILES` L2164）：
   - 7 类意图（methodological/visual/comparative/citation/factual/conceptual/general）由正则识别。
   - 每类意图给章节类型 boost：如 methodological → methods +1.5；factual → results +1.5；general → references **-2.4**、figure-caption -1.1——**模型问方法就把方法章节顶上来，问数据就把结果章节顶上来**。
5. **引用 boost**（L2437）：high-confidence 引用匹配 +10、medium +0.75、命中区块相邻 +0.35。
6. **启发式修正**（`scoreEvidenceHeuristics` L2239）：短块（<7 词 -0.7 / <12 词 -0.25）、引用列表样块（-1.3）、无 anchor 文本（-0.25）。
7. **跨篇汇总**（`retrievalService.ts`）：perPaperTopK=4（每篇选 4）→ topK=6（全局取 6）→ evidenceCache（查询规范化 key：小写+去标点+120 截断，同义改述共享缓存）。

### 第 4 层：候选选择与去重（L2463 之后 + constants）

- `RETRIEVAL_TOP_K_PER_PAPER=24` 粗选 → perPaper 精选 → `preferredChunkIndexes`（用户锁定块必须保留）。
- RRF_K=60、`RETRIEVAL_MMR_LAMBDA=0.7`：**MMR 去重**（相关度 − λ·多样性惩罚），防止返回整段同质章节。
- `MIN_ACTIVE_PAPER_CHUNKS=2 / OTHER=1 / FOLLOWUP_MIN=2·MAX=5`：追问时每篇至少 2 块、至多 5 块。

### 第 5 层：证据打包进 prompt（`buildEvidencePack` L2688 + retrievalService）

```
Retrieved Evidence:
[quote anchor guidance —— 可引用锚点提示]
- Paper 1: <citationLabel>; retrieved snippets: N   ← Paper coverage ledger
- Paper 2: <citationLabel>; retrieved snippets: M
<每条 snippet：chunkText + sectionLabel + pageStart-pageEnd + citationLabel>
「For this reply, prioritize these retrieved snippets as the primary evidence pack; 原全文仍在 paper chat 可查」
```

- **quote anchor 策略**（`buildEvidenceQuoteText` + `resolveEvidenceQuoteAnchorPolicy`）：候选块满足条件才生成可直接引用的引用卡（`QuoteCitation`），不合格块记录 rejection 原因（diagnostics）——**先验约束模型引用纪律**。
- `synthesisDigest`：跨篇综合摘要（哪些论文覆盖了问题的哪些方面）。

### 库级检索（第 0 层）

| 机制 | 说明 |
|---|---|
| `paperSearch.ts`（1128 行） | 字段级加权候选打分：DOI 前缀 1000 / 标题前缀 820 / 作者 / 期刊 / 年份 token +40 / 附件标题；全 token 命中 +260；`@`/`/`/`$` 特殊 token 语义（引用/skill 检索） |
| `libraryIndexService.ts`（971 行） | 全库 `searchable` 投影索引 + **增量 reconciliation**（监听 Zotero 变更事件重建，非全量） |
| `conversationSearchIndex.ts`（1078 行） | **历史对话全文索引**（SQLite 表，body 截断 200k），让模型能检索「以前聊过什么」 |

---

## 二、本项目现状（对照）

| 上游 | dsh-zotero | 差距 |
|---|---|---|
| 2000 字符分块 + 200 overlap + 句子边界 | `splitSections` 只按标题切，**无分块/无 overlap/无句子边界** | 粗粒度，切点可能砍断语义 |
| BM25（tf-idf 标准化） | `buildWindow` **章节词频计数**（`text.split(t).length-1` 求和） | 无 IDF/长度归一化，长章节天然高分 |
| LLM 查询改写 + 变体 + 语义查询 | **无**（query 原样切词） | 同义/缩写召回差一个量级 |
| Embedding 语义分 + 降级 | **无** | 无语义分 |
| RRF 融合 + MMR 去重 | 无融合，直接 score 排序 | 排序单调、结果同质 |
| 意图检测 + 章节 boost | **无** | 问方法不优先方法章节 |
| 证据打包 + 引用锚点 + coverage ledger | 注入的是「全文头部截断」+「让模型自己读章节」 | 无检索证据、无引用纪律先验 |
| 库级 searchable 索引 / 会话索引 | 借 Zotero `qmode=everything`（外置索引）+ `zotero_related` 题名/摘要子集重叠 | 无本机索引、无历史检索 |
| evidenceCache | sha1 翻译缓存有，检索缓存无 | 重复问题重复检索 |

---

## 三、本项目已做的优化（对照上游思路）

虽无完整 RAG 管线，但「文献查询读取」上已有几处务实优化：

1. **全文字符预算控制**（`buildPaperContext`，panel-api.ts L1074）：
   `budget = max(fullTextTokenBudget*2, 8000)` —— qa 注入只带全文头部 N 字符，而不是塞满整篇；`READ_PROMPT` + 工具描述教会模型**按需章节精读**（先免参拿 sections 偏移 → offset/limit 逐章读），而不是一次性读全文。
2. **章节偏移索引**（`splitSections` + `charOffsetOf`，tools-m2.ts L195/204）：
   `zotero_read_fulltext` 免参调用返回 `[{title, offset, charLen}]` 章节表 → 模型按 offset 精读 → **等效上游 splitMarkdownIntoChunks 的章节粒度**（但没有 chunk 化与索引）。
3. **关键词定位窗口**（`buildWindow` L214）：query 词在多章节打分、取 top5 拼窗口——词法与上游 BM25 同族，但**缺 IDF/长度归一化**。
4. **磁盘全文缓存**（MinerU/pdftotext → `cache/mineru/<key>/full.md`）：解析一次、多工具复用（read_pdf/read_fulltext/summarize/translate/panel）——即上游 PdfService.ensurePaperContext 的等位物。
5. **跨篇上下文**：`@` 引用最多 4 篇逐篇注入 → 模型可多文对照；`zotero_batch_summarize/review` 用 DSH 模型做分析——但**不检索原文**，只吃元数据/摘要/全文窗口。
6. **借 Zotero 内置全文索引**：`zotero_library_search qmode=everything` 关键字级全文搜索，零本机索引成本。
7. **确定性相关文献**（`zotero_related`）：题名+摘要 token 重叠打分（stopwords 过滤 + 归一化 score）——零 LLM、可解释，近似 paperSearch 的子集。

---

## 四、差距的本质

```
上游：问题 → 查询改写(语义+变体) → BM25×Embedding 融合 → 意图/章节加权 → MMR 精选
      → 证据打包(带引用锚点) → 注入模型（几 KB 高相关片段）
本插件：问题 → （原样）词法计数 → 章节粗筛 top5 / 或头部截断注入（数万字符低相关）
      → 模型自己循环工具精读（agentic 但无索引辅助）
```

**关键差距不是「有没有 LLM 检索」，而是「有没有事先建好的、带排序的检索件」**：
上游把「读什么」从模型运行时决策前移为**索引时静态构建 + 查询时确定排序**，模型只消费高相关证据包；
本插件把「读什么」留给模型用工具自行探索，靠 agentic 循环弥补——token 消耗高、相关性不确定、引用纪律依赖 prompt。

## 五、复刻进度（2026-08-31 已落地 `2b0b019` + `P2/P3/P4 增补`）

对照上游五层管线逐项核对——**核心检索件 + 链路级能力已可运行**：

| 上游机制 | 本插件状态 | 落地位置 |
|---|---|---|
| `splitMarkdownIntoChunks`（标题切章/段落累积/句子边界切片/200 overlap） | ✅ **完全复刻**（同款算法，含 `findSentenceBoundary` 缩写保护） | `src/retrieval/indexer.ts` |
| `buildChunkIndex`（tf/docFreq/avgLen 统计 + chunk 元数据） | ✅ **完全复刻**（sectionLabel/行号/页映射） | `src/retrieval/indexer.ts` |
| `scoreChunkBM25`（k1=1.2, b=0.75） | ✅ **完全复刻**（同参数） | `src/retrieval/rank.ts` |
| `detectQueryIntent`（7 类）+ `SECTION_BOOST_PROFILES` | ✅ **完全复刻** + 增强（补 `how is/are/how do` 正则→conceptual） | `src/retrieval/rank.ts` |
| `scoreEvidenceHeuristics`（短块/引用列表惩罚） | ✅ 复刻子集（无 anchorText/leadingNoise——本插件无该元数据源） | `src/retrieval/rank.ts` |
| `RetrievalService.evidenceCache` | ✅ **复刻**（规范化查询 key + LRU 200） | `src/retrieval/service.ts` |
| `zotero_retrieve` 工具 | ✅ **新增**（上游无同名工具，其检索是内部 service） | `src/tools-m2.ts` |
| `buildPaperContext` qa → 检索召回注入 | ✅ **rag 模式**（meta≈1.8K / rag≈5.9K / 旧 qa 头部 40K+） | `src/panel-api.ts` |
| **`retrievalQueryPlan`（LLM 变体改写）** | ✅ **已落地**：DSH 适配器生成同义/缩写/notation 变体 + 磁盘缓存（queryplans.json）+ 优雅降级确定性计划 | `src/retrieval/queryPlan.ts` + service/tools/panel 接线 |
| **MMR 多样性去重（λ=0.7）** | ✅ **已落地**（Jaccard token 度量 + 贪心 MMR） | `src/retrieval/rank.ts` |
| **引用 boost（high +10 / 相邻 +0.35）** | ✅ **已落地**（referenceChunkIndexes 入参） | `src/retrieval/rank.ts` |
| **body 证据保底** | ✅ **已落地**（evidence 模式确保含 results/discussion/methods 段） | `src/retrieval/rank.ts` |
| **证据打包（coverage ledger + score/offset 标注）** | ✅ **简化版落地**：`formatEvidencePack`（含覆盖说明），无上游 quote-anchor 校验 | `src/retrieval/service.ts` |
| `RetrievalService.retrieveEvidence` 跨篇 topK 聚合 | ⚠️ 部分（面板 @ 引用最多 4 篇逐个注入，无全局 topK 排序） | `src/panel-api.ts` |
| RRF 融合进打分管线 | ⚠️ 仅导出 `rrfFuse` 接口，未接入（单通道 BM25+boost；待 dense 通道） | P3 |
| `ensureEmbeddings` + cosine + embedding 降级 | ❌ 未复刻（纯词法；wave-rag dense 可作外部通道） | P5 |
| `paperSearch` / `libraryIndexService` / `conversationSearchIndex` | ❌ 未复刻（库级借 Zotero qmode + wave-rag zotero_search） | P6 |

## 六、我们在上游基础上的改进

| # | 改进 | 说明 |
|---|---|---|
| 1 | **意图检测正则补洞** | 上游 `detectQueryIntent` 的 conceptual 分支缺 `how is/are/how do`——"how is the shape matrix computed?" 在上游被判 `general`（章节 boost 平庸），我们补全后正确进 `conceptual`（discussion +1.4） |
| 2 | **检索成为一等公民工具** | 上游检索是 `RetrievalService` 内部逻辑，模型只能间接用；我们暴露 `zotero_retrieve`，模型可直接按问题取证据，且带缓存与延迟信息 |
| 3 | **注入策略可开关 + 两级成本** | `ragEnabled` 开关 + 前端 `rag` 标志（纯精读指令豁免）；rag 模式 ≈5.9K 字符 vs 旧 qa 40K+——**token 成本降一个数量级**，且证据更相关 |
| 4 | **零新依赖** | 上游 embedding/RRF/MMR 依赖模型 API 与 Zotero 进程内服务；我们的 P0「纯文本 BM25 + 缓存」零外部依赖，本地 4ms 出结果 |
| 5 | **复用 wave-rag 库级能力** | 库级语义检索不重复造轮子：LIBRARY_MODE prompt 引导模型优先 `zotero_search`（wave 图传播），单篇内用我们的 `zotero_retrieve`——**两级检索分工** |
| 6 | **证据缓存贴合 Chat 追问场景** | 同论文同问题二次追问 `cached=true` 零重算，追问体验无感知延迟 |

## 七、可移植路线（存量差异 → 续做优先级）

| 阶段 | 移植项 | 上游参考 | 本插件落点 |
|---|---|---|---|
| P5 | Embedding 语义通道（wave-rag dense 适配或 DSH embedding；纯词法为默认） | `ensureEmbeddings` + RRF 融合 | `src/retrieval/rank.ts` rrfFuse 已留接口 |
| P6 | 语义增量索引（shadow，抄 wave-rag 引擎） | `libraryIndexService` | M4+；库级暂借 Zotero qmode + wave-rag zotero_search |

> 前置依赖：M4 daemon 预解析（批量 MinerU → 缓存）是索引的数据源——先把「全部论文可解析」坐实，索引才有意义。当前缓存多为 pdftotext 降级产物（无标题 → 章节标签显示 (全文)），接 MinerU 后自动获得真实章节标签，boost 与检索质量同步提升。