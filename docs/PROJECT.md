# dsh-zotero 项目介绍

> DeepSeek Harness (DSH) 插件：把 Zotero 文献库搬进 AI 对话侧栏。
> 检索即读、PDF 沉浸阅读、划词即译、一键全文翻译、文献级 Chat、MinerU 精读解析、批量文献分析。

`@dsh-external/dsh-zotero` 是一个 **hybrid 形态**的 DSH 插件：

- **host 侧**（Cordis 插件）：直连 **Zotero Local API**（`127.0.0.1:23119`）读元数据/全文/附件，
  接入 **MinerU**（云端 mineru.net / 本地 mineru-api）做高保真论文解析，封装 **pdf2zh** 官方 CLI
  做一键全文翻译，并通过 DSH **模型适配器**调用任意已配置 LLM。
- **client 侧**（React 面板）：注册到 DSH 对话页的 `conversation.view` tab 与独立浮动文献聊天窗，
  提供库检索、PDF 沉浸阅读、划词翻译、左右对照、全文翻译、MD 解析管理、设置热生效等完整交互。

重构自 [yilewang/llm-for-zotero](https://github.com/yilewang/llm-for-zotero)（AGPL-3.0，
上游运行于 Zotero 进程内；本插件改为**进程外 Local API + DSH 侧栏**形态，见 `docs/M0-audit.md`）。

---

## 一、特性总览

| 模块 | 能力 |
|---|---|
| **库接入** | Zotero 9+ Local API 直连（本地 API 为主，Web API userId/apiKey 降级）；987 条真实库、114 收藏夹实测 |
| **检索/浏览** | 标题/作者/标签/全文 qmode=everything；收藏夹树 + itemType 过滤 + 分页 |
| **PDF 阅读** | pdf.js 自渲染阅读器：分页 canvas + TextLayer、IntersectionObserver 懒渲染、缩放、页面切换 |
| **沉浸阅读** | 阅读时隐藏 tab 与详情行，正文占满面板；「← 列表」一键返回 |
| **划词即译** | 选中英文 →「译」浮钮 → 气泡译文（LLM 翻译 + sha1 磁盘缓存 + 论文上下文注入，Intl.Segmenter 长文分块并发） |
| **一键全文翻译** | pdf2zh 官方 CLI（uv 独立 Python 3.12 环境）产出 **双语 PDF**（原文+译文同页）与纯译文 PDF，页内 iframe 呈现 |
| **左右对照** | 原文（左）/ 译文 mono（右）双文档同步翻页，滚动按比例联动，连页边界翻页 |
| **文献 Chat** | 独立浮动聊天窗：**每篇论文一个会话** + 文献库会话，全文注入、@论文引用、模型选择器、工具行真实调用（zotero_read_pdf / zotero_summarize …） |
| **MinerU 精读** | cloud v4（batch→OSS 上传→轮询→zip）或 local `/file_parse`；表格/公式/图高保真；失败自动 pdftotext 降级 |
| **MD 解析管理** | 面板内批量队列（并发 4、取消、进度、错误清单）、解析进度统计（已解析 X / Y）、修复缓存、一键清空 |
| **文献分析** | `zotero_batch_summarize`（2–10 篇批量概述）、`zotero_review`（跨文综述：谱系/方法族/共识/分歧/空白）、`zotero_related`（确定性关键词重叠找相关文，零 LLM） |
| **产出物区** | 读全文/概述自动沉淀，复制/清空 |
| **设置热生效** | 全部配置面板化，`settings.json` 覆盖层写入后**免重载生效**，秘钥掩码显「已设置」 |

## 二、界面截图

### 1. 库检索与列表（右栏 Zotero tab）

点开任意条目即进入 PDF 阅读；无 PDF 的条目显示详情卡。「文献库 CHAT」打开库级会话。

<img src="images/panel-library.png" alt="库检索与列表" width="420"/>

### 2. 沉浸式 PDF 阅读（pdf.js 自渲染）

进入阅读后自动隐藏 tab 与详情行，正文铺满面板。工具栏：`← 列表 · 划词翻译 · 侧边栏/两页/页脚 · 缩放 · 一键全文翻译 · 左右对照`。

<img src="images/panel-reading.png" alt="沉浸式 PDF 阅读" width="420"/>

### 3. 文献库 Chat 浮动窗

独立于主对话的文献聊天：左侧 History（文献库 + 逐论文会话），右侧会话区；
`Paper chat` 模式注入论文全文，可 @引用其他论文、切换会话模型、请求 Diagram（图/表/公式）。

<img src="images/panel-paper-chat.png" alt="文献库 Chat 浮动窗" width="460"/>

## 三、工具清单（11 个）

| 工具 | 说明 |
|---|---|
| `zotero_health` | Local/Web API 健康检测（精确区分未运行 / Local API 未开启 / 可用，含 Zotero 9 开启指引） |
| `zotero_library_search` | 库检索（q/qmode=everything/tag/collection/itemType/sort/分页） |
| `zotero_get_item` | 条目详情（元数据 + 附件/笔记/批注 + 文件下载路径） |
| `zotero_collections` | 收藏夹树（parentKey/depth/itemCount） |
| `zotero_read_pdf` | PDF → MinerU（cloud/local）→ 磁盘缓存；失败自动 pdftotext 降级并显式标注 |
| `zotero_read_fulltext` | 按章节窗口读取已解析全文（MinerU full.md 缓存） |
| `zotero_summarize` | 概述 / 定向 / 深度总结（mode×depth，DSH 模型，prompt 可配置） |
| `zotero_translate` | 文献翻译（text 直译或 itemKey 全文窗口；保留 Markdown/公式/数字） |
| `zotero_batch_summarize` | 2–10 篇批量概述 + 跨文对比（方法谱系/共识/分歧/空白） |
| `zotero_review` | 跨文综述（点提取 + 结构化综述，入参 itemKeys 或 query+n 自动收集） |
| `zotero_related` | 按标题+摘要关键词重叠找相关论文（确定性打分，零 LLM） |

## 四、架构

```
┌────────────── DSH Web（浏览器） ──────────────┐
│  conversation.view tab：Zotero 面板（React）   │
│   · 库 / 产出物 / 设置                         │
│  document.body：文献 Chat 浮动窗（独立 root）   │
└──────────────┬─────────────────────────────────┘
               │ fetch /@dsh-external/dsh-zotero/api/*
┌──────────────▼─────────────────────────────────┐
│ host（Cordis 插件, src/panel-api.ts）           │
│  /verify /tree /item /pdf /pdfjs-worker        │
│  /translate /pdf2zh/* /mineru/* /config        │
│  /chat-open /chat-send /chat-messages /chat-*  │
└──┬────────────┬──────────────┬─────────────────┘
   │            │              │
   ▼            ▼              ▼
 Zotero       MinerU         LLM（DSH 模型适配器）
 Local API    cloud v4 /     · 划词/全文翻译（translate.ts, sha1 缓存）
 127.0.0.1    local :8000    · 概述/精读/文献分析
 :23119       ↘ 磁盘缓存     · pdf2zh CLI（双语 PDF）
              cache/mineru/
```

**关键机制**

- **Local API 附件下载**：Zotero 9 返回 `302 → file:///C:/Users/.../storage/...`，
  客户端 `redirect:'manual'` + file URL → 磁盘直读（`fileUrlToWindowsPath`），无需配置存储目录。
- **阅读器**：`getDocument(ArrayBuffer)` 分页渲染；多页比例中位数校准页高；
  `renderedH` 状态标定高度；单 IntersectionObserver + 滚动节流回收，数千页不卡。
- **划词翻译**：selection 提取 →「译」浮钮 → `/translate`（LLM + 缓存）+ 论文上下文注入。
- **全文翻译**：`uv tool run` pdf2zh 后台任务，解析 `pdf2zh-page N/M` 进度行，
  完成后 `*-dual.pdf`（双语）、`*-mono.pdf`（译文）缓存于 `cache/pdf2zh/<attachmentKey>/`。
- **文献会话**：确定性会话 id `zotero-paper-<itemKey>` / `zotero-library`，
  cwd 链自父会话继承，消息缓存由 `session/event` 订阅累积，agent 冷启动自动 `resume`。
- **配置热生效**：schema 为唯一契约；`DSH_HOME/data/dsh-zotero/settings.json` 覆盖层，
  `sanitizeOverlay` 白名单校验后写盘 → `setActiveConfig` + `client.updateConfig`。

## 五、里程碑进度

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 上游审计（llm-for-zotero 3.9.2，功能/资产/契约映射） | ✅ `docs/M0-audit.md` |
| M1 | Local API 连接层 + 4 个检索工具 + 健康检测 | ✅ |
| M2 | MinerU client（cloud/local）+ 零依赖 ZIP 读取 + 磁盘缓存 + 读全文/概述/翻译 | ✅ |
| M3 | 右侧栏面板（库/产出物/设置）+ 设置热生效 + PDF 面板内预览 | ✅ `docs/M3.md` |
| M3.2 | 独立文献聊天窗（Paper chat / 文献库对话 / @引用 / 模型选择） | ✅ `docs/M3.2-chat-window.md` |
| M3.3 | pdf.js 自渲染阅读 + 划词即译 + pdf2zh 全文翻译 + 左右对照 + 沉浸阅读 | ✅ |
| M3.4 | MD 解析管理（批量队列/统计/清缓存）+ 文献分析工具（batch/review/related） | ✅ |
| M4 | 笔记回写、daemon 预解析、RAG（规划中） | ⏳ |

## 六、开发迭代

- **构建**：`bash scripts/build.sh`（自动探测 DSH checkout / installed dsh + donor toolchain）
  + `npm run build:client`（tsdown 出 `lib/client.js` 单文件 bundle，pdfjs-dist 为 alwaysBundle 依赖）。
- **注入/重载**：注入器 `dev_inject_plugin` / `dev_reload_package` 热更新。
- **构建标识**：`src/client/index.tsx` `BUILD_TAG`（设置页可见，便于确认浏览器已加载新 bundle）。
- 详细日志归档：`docs/RESTART-20260828.md` 等。

## 七、许可与致谢

- 本插件 **MIT**（`LICENSE`），**BSD-3-Clause**（package.json 字段）。
- 重构自 [llm-for-zotero](https://github.com/yilewang/llm-for-zotero)（**AGPL-3.0-or-later**）：
  移植其 MinerU 集成契约、检索/分块常量、引用纪律 prompt 资产；按 AGPL 要求保留出处声明与
  `docs/M0-audit.md` 审计报告。
- 关键依赖：pdfjs-dist（客户端渲染）、pdf2zh（全文翻译 CLI）、MinerU（文档解析服务）。