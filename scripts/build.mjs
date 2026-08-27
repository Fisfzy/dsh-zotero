#!/usr/bin/env node
/**
 * dsh-zotero host build — junction-link build/runtime deps, then tsc.
 *
 * Modes (auto-probed):
 *   1. Source checkout: DSH_CHECKOUT env or <HOME>/dsh-harness|dsh|.dsh/dsh-harness
 *   2. Installed dsh: npm-global @deepseek-ai/dsh + donor plugin carrying
 *      typescript/cordis/cosmokit/tsdown under ~/.dsh/.external-plugins.
 *
 * All linking is deterministic: each target is recreated as a junction
 * (Windows) or symlink. Run via `node scripts/build.mjs` (host half); the
 * client half is `tsdown` (package.json build:client).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NM = join(ROOT, 'node_modules')

function log(msg) {
  console.log(`[dsh-zotero build] ${msg}`)
}

function fail(msg) {
  console.error(`[dsh-zotero build] ${msg}`)
  process.exit(1)
}

/** Link `node_modules/<rel>` -> <source> (junction on win32, dir symlink elsewhere). */
function linkPkg(rel, source) {
  const abs = resolve(source)
  if (!existsSync(abs)) fail(`dependency target missing: ${abs}`)
  const link = join(NM, rel)
  rmSync(link, { recursive: true, force: true })
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(abs, link, process.platform === 'win32' ? 'junction' : 'dir')
}

function probeCheckout() {
  const env = process.env.DSH_CHECKOUT
  if (env && existsSync(join(env, 'packages'))) return env
  const home = homedir()
  for (const cand of ['dsh-harness', 'dsh', '.dsh/dsh-harness']) {
    const p = join(home, cand)
    if (existsSync(join(p, 'packages'))) return p
  }
  return null
}

function donorNodeModules() {
  const home = homedir()
  const ext = join(home, '.dsh', '.external-plugins')
  if (existsSync(ext)) {
    for (const entry of readdirSync(ext)) {
      const nm = join(ext, entry, 'node_modules')
      if (existsSync(join(nm, 'typescript')) && existsSync(join(nm, 'cordis')) && existsSync(join(nm, 'tsdown'))) {
        return nm
      }
    }
  }
  return null
}

function main() {
  const checkout = probeCheckout()
  const donor = donorNodeModules()
  const npmGlobal = (() => {
    // npm is npm.cmd on Windows: spawn through a shell.
    const r = spawnSync('npm root -g', { shell: true, encoding: 'utf8' })
    return r.status === 0 ? r.stdout.trim() : ''
  })()
  const dshNm = npmGlobal ? join(npmGlobal, '@deepseek-ai', 'dsh', 'node_modules') : ''
  if (checkout) {
    log(`mode: source checkout (${checkout})`)
    mkdirSync(NM, { recursive: true })
    linkPkg('cordis', join(checkout, 'vendor', 'cordis'))
    linkPkg('cosmokit', join(checkout, 'vendor', 'cosmokit'))
    linkPkg('schemastery', join(checkout, 'vendor', 'schemastery'))
    linkPkg('@deepseek-ai/schemastery', join(checkout, 'vendor', 'schemastery'))
    linkPkg('@deepseek-ai/dsh-tools', join(checkout, 'packages', 'core', 'tools'))
    linkPkg('@deepseek-ai/dsh-llm', join(checkout, 'packages', 'llm', 'llm'))
    linkPkg('@deepseek-ai/dsh-system-prompt', join(checkout, 'packages', 'core', 'system-prompt'))
    linkPkg('@types/node', join(checkout, 'node_modules', '@types', 'node'))
    linkPkg('typescript', join(checkout, 'node_modules', 'typescript'))
    if (donor) {
      linkPkg('tsdown', join(donor, 'tsdown'))
    }
    const tsc = firstExisting(join(checkout, 'node_modules', 'typescript', 'tsc'), join(checkout, 'node_modules', 'typescript', 'bin', 'tsc'))
    runTsc(tsc)
    return
  }

  log('mode: installed dsh (no source checkout)')
  if (!npmGlobal) fail('npm root -g failed')
  if (!existsSync(join(dshNm, '@deepseek-ai'))) fail(`installed dsh not found: ${dshNm}`)
  if (!donor) fail('no donor plugin with typescript+cordis+tsdown under ~/.dsh/.external-plugins')

  log(`linking deps (donor: ${donor})`)
  linkPkg('cordis', join(donor, 'cordis'))
  linkPkg('cosmokit', join(donor, 'cosmokit'))
  linkPkg('typescript', join(donor, 'typescript'))
  linkPkg('tsdown', join(donor, 'tsdown'))
  linkPkg('@deepseek-ai/dsh-tools', join(dshNm, '@deepseek-ai', 'dsh-tools'))
  linkPkg('@deepseek-ai/dsh-llm', join(dshNm, '@deepseek-ai', 'dsh-llm'))
  linkPkg('@deepseek-ai/schemastery', join(dshNm, '@deepseek-ai', 'schemastery'))
  linkPkg('@deepseek-ai/dsh-system-prompt', join(dshNm, '@deepseek-ai', 'dsh-system-prompt'))
  linkPkg('@types/node', join(dshNm, '@types', 'node'))
  linkPkg('@deepseek-ai/dsh-client-ui-slots', firstExisting(
    join(dshNm, '@deepseek-ai', 'dsh-client-ui-slots'),
    ...candidateSlots(),
  ))
  runTsc(firstExisting(join(donor, 'typescript', 'tsc'), join(donor, 'typescript', 'bin', 'tsc')))
}

function candidateSlots() {
  const ext = join(homedir(), '.dsh', '.external-plugins')
  if (!existsSync(ext)) return []
  const out = []
  for (const entry of readdirSync(ext)) {
    const p = join(ext, entry, 'node_modules', '@deepseek-ai', 'dsh-client-ui-slots')
    if (existsSync(p)) out.push(p)
  }
  return out
}

function firstExisting(...paths) {
  for (const p of paths) {
    if (existsSync(p)) return p
  }
  return undefined
}

function runTsc(tscJs) {
  if (!tscJs) fail('tsc not found (typescript package)')
  log(`tsc: ${tscJs}`)
  const r = spawnSync(process.execPath, [tscJs, '-p', join(ROOT, 'tsconfig.json')], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  if (r.status !== 0) fail(`tsc exited ${r.status}`)
  log('host compile OK → lib/')
}

main()
