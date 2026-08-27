# @dsh-external/dsh-zotero

Zotero 库接入 DSH：Local API 检索/阅读/笔记 + MinerU 全文解析 + 右侧栏面板。
重构自 [yilewang/llm-for-zotero](https://github.com/yilewang/llm-for-zotero)（AGPL-3.0，见 `docs/M0-audit.md`）。

> 架构决策/功能清单/MinerU 契约：`docs/M0-audit.md` · 里程碑进度：`docs/M1-M2.md` · 面板与设置：`docs/M3.md`（含面板截图）。

## 工具（7 个）

- `zotero_health` — Local/Web API 健康检测（含 Zotero 9 本地 API 关闭的精确指引）
- `zotero_library_search` — 库检索（qmode=everything 全文、tag/collection/itemType 过滤）
- `zotero_get_item` — 条目详情（元数据 + 附件/笔记/批注 + 文件下载路径）
- `zotero_collections` — 收藏夹树
- `zotero_read_pdf` — PDF → MinerU（cloud/local）→ 缓存；失败自动 pdftotext 降级
- `zotero_summarize` — 概述/定向总结（DSH 默认模型，prompt 可配置）
- `zotero_translate` — 文献翻译（text 或全文窗口）

## 前置（Zotero 9+）

Local API 默认关闭：Settings → Advanced → Config Editor →
`httpServer.localAPI.enabled = true`。或配置 Web API userId/apiKey 降级。

## 构建与注入

```bash
bash scripts/build.sh        # 自动探测 DSH_CHECKOUT / installed dsh + donor toolchain
npm run build:client         # tsdown 客户端包
# 注入器环境内：dev_inject_plugin <本目录>
```

## 配置（插件 schema，均可在设置面板改）

localApiHost/Port/Key · webUserId/webApiKey（降级）· requestTimeoutMs · searchLimit ·
storageDir（PDF 直读兜底）· mineruMode/localApiBase/localBackend/cloudApiKey/cloudModel/forceOcr/maxAutoPages ·
fullTextTokenBudget · chatWithPdfPrompt/summaryPrompt/translatePrompt · ragEnabled · cacheDir
