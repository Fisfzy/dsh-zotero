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
  /**
   * dsh 0.1.2-alpha.1（cordis 4.0.1）：可选服务经 ctx.get 取不到（隔离作用域），
   * 官方姿势（见 dsh-cae-agent index.d.ts 注释）是把 webServer 声明进 inject，
   * 作为 ctx 上下文属性使用（"a nested ctx.inject was not firing"）。
   */
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: unknown, res: unknown) => void | Promise<void>
    }): () => void
  }
  get(name: string): unknown
}

export const name = PLUGIN_ID
export const inject = ['tools', 'llm', 'webServer']

export { Config }

export function apply(ctx: HostContext, config: ZoteroConfig): void {
  const log = (m: string): void => {
    const line = `[dsh-zotero] ${m}`
    console.log(line)
    try {
      ctx.logger?.info?.(line)
    } catch { /* best-effort */ }
  }
  log('apply start')
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
  log('tools registered')

  // Panel bridge route (host ↔ browser half)。0.1.2 按 cae-agent 范式从 inject 取 webServer。
  const webServer = ctx.webServer as
    | { register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }): () => void }
    | undefined
  log(`webServer present=${Boolean(webServer?.register)}`)
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
      log(`route registered ${API_PREFIX}`)
      return () => {
        dispose()
        log('route disposed')
      }
    }, `${PLUGIN_ID}: panel api route`)
  }

  ctx.logger?.info?.(`${PLUGIN_ID}: mounted (local API base=${client.localBase()})`)
  log('apply done')
}
