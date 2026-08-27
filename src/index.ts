/**
 * @dsh-external/dsh-zotero — hybrid plugin host entry.
 *
 * M1: Zotero Local API connection layer + health detection + three tools
 *     (zotero_library_search / zotero_get_item / zotero_collections).
 * M2: MinerU parsing + zotero_read_pdf / zotero_summarize / zotero_translate
 *     (LLM 复用 DSH 模型适配器与默认模型，prompt 可由配置覆盖).
 * M3: panel bridge routes (library tree / item detail / read / summarize /
 *     inject-context / artifacts) consumed by the conversation.view tab.
 *
 * Architecture (see ../docs/M0-audit.md):
 *   Zotero Local API (127.0.0.1:23119, primary) → Web API fallback
 *   → MinerU parsing → disk cache; prompts/LLM reuse DSH adapters.
 */
import type { Context } from 'cordis'
import type LlmService from '@deepseek-ai/dsh-llm'
import { ZoteroClient } from './zotero/client.ts'
import { registerZoteroTools } from './tools.ts'
import { registerM2Tools } from './tools-m2.ts'
import { Config } from './config.ts'
import type { Config as ZoteroConfig } from './config.ts'
import type { ResolvedModel } from './ml.ts'
import { API_PREFIX, PLUGIN_ID, panelApiHandler } from './panel-api.ts'
import { composeConfig, setActiveConfig, setBaseConfig } from './runtime.ts'

type HostContext = Context & {
  tools: { register(tool: unknown): void }
  llm: LlmService
  get(name: string): unknown
}

export const name = PLUGIN_ID
export const inject = ['tools', 'llm']

export { Config }

export function apply(ctx: HostContext, config: ZoteroConfig): void {
  // cordis 组合配置为基底，settings.json 覆盖层在上（面板「设置」可写、热生效）。
  setBaseConfig(config)
  setActiveConfig(composeConfig())
  const active = composeConfig()

  const client = new ZoteroClient({ config: active })
  const agentDefaultModel = ctx.get('agentDefaultModel') as { currentSelection(): ResolvedModel } | undefined
  registerZoteroTools(ctx as { tools: { register(tool: unknown): void } }, client, active)
  registerM2Tools(
    ctx as { tools: { register(tool: unknown): void } },
    client,
    active,
    ctx.llm,
    agentDefaultModel,
  )

  // Panel bridge route (host ↔ browser half). Optional dependency: in
  // headless compositions without the webserver this is silently skipped.
  const webServer = ctx.get('webServer') as
    | { register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }): () => void }
    | undefined
  if (webServer?.register) {
    ctx.effect(() => {
      const dispose = webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) =>
          panelApiHandler({
            client,
            llm: ctx.llm,
            agentDefaultModel,
            agents: ctx.get('agents'),
          })(req as never, res as never),
      })
      return () => dispose()
    }, `${PLUGIN_ID}: panel api route`)
  }

  ctx.logger?.info?.(`${PLUGIN_ID}: mounted (local API base=${client.localBase()})`)
}
