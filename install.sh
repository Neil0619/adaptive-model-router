#!/usr/bin/env sh

set -u

if ! command -v node >/dev/null 2>&1; then
  echo "Adaptive Model Router requires Node.js 24.15.0 or newer." >&2
  exit 2
fi

if ! node -e 'const v=process.versions.node.split(".").map(Number); process.exit(v[0]>24 || (v[0]===24 && v[1]>=15) ? 0 : 1)' >/dev/null 2>&1; then
  echo "Adaptive Model Router requires Node.js 24.15.0 or newer." >&2
  exit 2
fi

if ! command -v git >/dev/null 2>&1; then
  echo "Adaptive Model Router requires Git." >&2
  exit 2
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "Adaptive Model Router requires the Codex CLI." >&2
  exit 2
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/plugins/adaptive-model-router/scripts/manage-install.mjs" "$@"
