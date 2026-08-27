#!/bin/bash
# dsh-zotero host build — thin delegate to scripts/build.mjs (Node does the
# junction linking + tsc; the client half is `npm run build:client`=tsdown).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
node scripts/build.mjs
