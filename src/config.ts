/**
 * dsh-zotero — plugin configuration (Schemastery).
 *
 * All user-facing settings live here (per the aligned plan): Zotero Local API
 * endpoint, Web API fallback credentials, MinerU backend, full-text token
 * budget, overridable prompts, RAG switch. Defaults are written into the
 * schema so a bare install works out of the box.
 */
import z from '@deepseek-ai/schemastery'

export interface Config {
  /** Zotero Local API host (desktop HTTP server). */
  localApiHost: string
  /** Zotero Local API port (default 23119; Zotero 8 may use api.httpServer.port). */
  localApiPort: number
  /** Optional bearer key; the Local API trusts loopback by default, set only when the user enabled key auth. */
  localApiKey: string
  /** Zotero Web API user id ('' disables the fallback). */
  webUserId: string
  /** Zotero Web API key ('' disables the fallback). */
  webApiKey: string
  /** HTTP request timeout for Zotero endpoints. */
  requestTimeoutMs: number
  /** Default page size for item searches. */
  searchLimit: number
  /** Zotero data root (the parent of `storage/`); optional on-disk PDF fallback. */
  storageDir: string
  /** MinerU backend: local (mineru-api service) or cloud (mineru.net). */
  mineruMode: 'local' | 'cloud'
  /** MinerU local service base, e.g. http://127.0.0.1:8000 */
  mineruLocalApiBase: string
  /** MinerU local backend engine. */
  mineruLocalBackend: 'pipeline' | 'vlm' | 'hybrid'
  /** MinerU cloud API key ('' disables cloud mode). */
  mineruCloudApiKey: string
  /** MinerU cloud model. */
  mineruCloudModel: 'pipeline' | 'vlm'
  /** Force OCR in MinerU parsing. */
  mineruForceOcr: boolean
  /** Auto-parse page cap for background/daemon parsing. */
  mineruMaxAutoPages: number
  /** Full-text token budget handed to the model in one read call. */
  fullTextTokenBudget: number
  /** Override for the paper-chat grounding instructions (empty = shipped default). */
  chatWithPdfPrompt: string
  /** Override for the paper-summary prompt (empty = shipped default). */
  summaryPrompt: string
  /** Override for the translation prompt (empty = shipped default). */
  translatePrompt: string
  /** Library-level RAG (M4; keep off until the index pipeline is enabled). */
  ragEnabled: boolean
  /** Cache directory for MinerU outputs and RAG index (empty = DSH_HOME/data/dsh-zotero/cache). */
  cacheDir: string
}

export const Config = z.object({
  localApiHost: z.string().default('127.0.0.1'),
  localApiPort: z.number().min(1).max(65535).default(23119),
  localApiKey: z.string().default(''),
  webUserId: z.string().default(''),
  webApiKey: z.string().default(''),
  requestTimeoutMs: z.number().min(1000).max(120000).default(15000),
  searchLimit: z.number().min(1).max(100).default(25),
  storageDir: z.string().default(''),
  mineruMode: z.union(['local', 'cloud']).default('local'),
  mineruLocalApiBase: z.string().default('http://127.0.0.1:8000'),
  mineruLocalBackend: z.union(['pipeline', 'vlm', 'hybrid']).default('pipeline'),
  mineruCloudApiKey: z.string().default(''),
  mineruCloudModel: z.union(['pipeline', 'vlm']).default('vlm'),
  mineruForceOcr: z.boolean().default(false),
  mineruMaxAutoPages: z.number().min(1).default(100),
  fullTextTokenBudget: z.number().min(1000).default(20000),
  chatWithPdfPrompt: z.string().default(''),
  summaryPrompt: z.string().default(''),
  translatePrompt: z.string().default(''),
  ragEnabled: z.boolean().default(false),
  cacheDir: z.string().default(''),
})
