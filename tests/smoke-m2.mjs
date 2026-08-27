/**
 * dsh-zotero M2 smoke tests — no network, no Zotero:
 *  1. zip.ts: build a zip with node:zlib (raw deflate) → unpackMineruZip
 *  2. cache dir resolution
 * Run: node tests/smoke-m2.mjs
 */
import { deflateRawSync } from 'node:zlib'

const { unpackMineruZip } = await import('../lib/mineru/zip.js')
const { resolveCacheDir } = await import('../lib/mineru/cache.js')

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failed += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

/** Minimal zip writer: store/deflate entries, local headers + central dir + EOCD. */
function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, bytes] of entries) {
    const nameBytes = Buffer.from(name, 'latin1')
    const comp = deflateRawSync(Buffer.from(bytes))
    const method = 8
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // flags: UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 10) // crc (reader ignores)
    local.writeUInt32LE(comp.length, 14)
    local.writeUInt32LE(bytes.length, 18)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, comp)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + comp.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]))
}

// 1) zip unpack
console.log('[1] unpackMineruZip')
const zipBytes = buildZip([
  ['full.md', new TextEncoder().encode('# Title\n\nAbstract text.\n\n## Method\n\nDetails.')],
  ['images/fig-1.png', new Uint8Array([1, 2, 3, 4])],
  ['content_list.json', new TextEncoder().encode('[]')],
])
const res = unpackMineruZip(zipBytes)
check('ok', res.ok === true)
if (res.ok) {
  check('md has full.md content', res.md.includes('Abstract text.'))
  check('md has section heading', res.md.includes('## Method'))
  check('images captured', res.files.some((f) => f.relPath === 'images/fig-1.png'))
  check('json asset captured', res.files.some((f) => f.relPath === 'content_list.json'))
}

const bad = unpackMineruZip(new TextEncoder().encode('this is not a zip'))
check('bad zip → ok:false', bad.ok === false)

// 2) cache dir resolution
console.log('[2] resolveCacheDir')
const dir = resolveCacheDir({ cacheDir: '' })
check('default under DSH_HOME or ~/.dsh', dir.includes('dsh-zotero'))
check('custom cacheDir honored', resolveCacheDir({ cacheDir: 'C:/tmp/custom-cache' }) === 'C:/tmp/custom-cache')

if (failed) {
  console.error(`\nFAILED ${failed}`)
  process.exit(1)
}
console.log('\nall M2 smoke checks passed')
