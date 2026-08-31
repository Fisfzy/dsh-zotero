# @dsh-external/dsh-zotero

> 把 Zotero 文献库搬进 DeepSeek Harness 对话侧栏 — 检索即读、PDF 沉浸阅读、划词即译、一键全文翻译、文献级 Chat、MinerU 精读、批量文献分析。

**DSH hybrid 插件**：host（Cordis）直连 **Zotero Local API**（`127.0.0.1:23119`）+ **MinerU**（云端/本地）精读解析 + **pdf2zh** 全文翻译 + DSH 模型适配器；client（React）右侧栏面板 + 独立文献聊天窗。
重构自 [yilewang/llm-for-zotero](https://github.com/yilewang/llm-for-zotero)（AGPL-3.0，出处与审计见 `docs/M0-audit.md`）。

## 界面一览

| 库检索与列表 | 沉浸式 PDF 阅读 | 文献库 Chat 浮窗 |
|---|---|---|
| 点条目即读；收藏夹树 + 全文检索 | pdf.js 自渲染，正文铺满面板 | 逐论文会话 + @引用 + 模型切换 |
| <img src="docs/images/panel-library.png" alt="库列表" width="260"/> | <img src="docs/images/panel-reading.png" alt="沉浸阅读" width="260"/> | <img src="docs/images/panel-paper-chat.png" alt="文献 Chat" width="300"/> |

## 功能亮点

- **📚 库检索/浏览** — Zotero 9+ Local API 直连（Web API 自动降级）；标题/作者/标签/全文（qmode=everything）；收藏夹树 + itemType 过滤 + 分页。
- **📖 PDF 沉浸阅读** — pdf.js 自渲染（懒渲染 + 缩放 + 页码导航），阅读时隐藏 tab/详情行、正文占满；「← 列表」一键返回。
- **🖱 划词即译** — 选中英文即弹「译」浮钮 → 气泡译文；LLM 翻译 + sha1 磁盘缓存 + 论文上下文注入，长文自动分块并发。
- **🌐 一键全文翻译** — pdf2zh 官方 CLI 产出**双语 PDF**（原文+译文同页）与纯译文 PDF，页内 iframe 呈现；另有**左右对照**双文档同步翻页。
- **💬 文献 Chat** — 独立浮动窗：每篇论文一个会话 + 文献库会话；全文注入、`@` 引用其他论文、会话级模型选择器。
- **🔬 MinerU 精读** — cloud v4 / local `:8000`；表格/公式/图高保真；失败自动 pdftotext 降级；面板内**批量解析管理**（队列/进度/清缓存）。
- **📊 文献分析** — 批量概述（2–10 篇）、跨文综述、相关论文推荐（确定性关键词重叠）。
- **⚙️ 设置热生效** — 全部配置面板化，`settings.json` 覆盖层写入即生效，秘钥掩码。

## 工具（11 个）

| 工具 | 说明 |
|---|---|
| `zotero_health` | Local/Web API 健康检测（含 Zotero 9 Local API 开启指引） |
| `zotero_library_search` | 库检索（qmode=everything 全文、tag/collection/itemType 过滤） |
| `zotero_get_item` | 条目详情（元数据 + 附件/笔记/批注 + 文件下载路径） |
| `zotero_collections` | 收藏夹树 |
| `zotero_read_pdf` | PDF → MinerU（cloud/local）→ 缓存；失败自动 pdftotext 降级 |
| `zotero_read_fulltext` | 按章节窗口读取已解析全文 |
| `zotero_summarize` | 概述/定向/深度总结（DSH 模型，prompt 可配置） |
| `zotero_translate` | 文献翻译（text 或全文窗口） |
| `zotero_batch_summarize` | 2–10 篇批量概述 + 跨文对比 |
| `zotero_review` | 跨文综述（谱系/方法族/共识/分歧/空白） |
| `zotero_related` | 相关论文推荐（关键词重叠，零 LLM） |

## 快速开始

1. **Zotero 9+**：Settings → Advanced → Config Editor → `httpServer.localAPI.enabled = true`（默认关闭）。
   或配置 Web API userId/apiKey 降级。
2. **安装插件**（注入器环境）：`dev_inject_plugin <本目录>`；或 `npm pack` → 常规安装。
3. **打开对话页** → 侧栏出现 **Zotero** tab → 点任意论文进入沉浸阅读 / 「文献 CHAT」开聊。
4. **（可选）全文翻译**：`uv tool install --python 3.12 pdf2zh`，设置页填 OpenAI 兼容接口（如 DeepSeek）。
   **（可选）MinerU 云解析**：设置页填 mineru.net API Key 并「测试连接」。

## 构建与注入

```bash
bash scripts/build.sh        # 自动探测 DSH_CHECKOUT / installed dsh + donor toolchain
npm run build:client         # tsdown 客户端单文件 bundle（pdfjs-dist alwaysBundle）
# 注入器环境内：dev_inject_plugin <本目录>；改代码后 dev_reload_package
```

## 配置（插件 schema，均可在设置面板改、热生效）

`localApiHost/Port/Key` · `webUserId/webApiKey`（降级）· `searchLimit` · `storageDir`
· `mineruMode/localApiBase/localBackend/cloudApiKey/cloudModel/forceOcr/maxAutoPages`
· `pdf2zhBaseUrl/ApiKey/Model/Threads` · `translateTargetLang` · `fullTextTokenBudget`
· `summaryPrompt/translatePrompt/chatWithPdfPrompt` · `ragEnabled` · `cacheDir`

## 文档

- `docs/PROJECT.md` — 项目介绍（特性/架构/里程碑/迭代）
- `docs/M0-audit.md` — 上游审计与移植决策
- `docs/M1-M2.md` · `docs/M3.md` · `docs/M3.2-chat-window.md` — 里程碑进度

## 许可

本插件 MIT（`LICENSE`）/ BSD-3-Clause（package.json）；重构自 AGPL-3.0 的 llm-for-zotero，保留出处声明。