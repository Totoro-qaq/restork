#!/usr/bin/env bash
set -euo pipefail

if ! command -v rg >/dev/null 2>&1; then
  echo "error: ripgrep (rg) is required for the public artifact scan" >&2
  exit 2
fi

pattern='(gh[pous]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|DEEPSEEK_API_KEY\s*=)'

matches="$(rg -n --hidden \
  --glob '!.git/**' \
  --glob '!dashboard/node_modules/**' \
  --glob '!*.lock' \
  --glob '!tests/fixtures/**' \
  "$pattern" \
  . || true)"

if [[ -n "$matches" ]]; then
  echo "error: possible credential material found in public artifacts:" >&2
  echo "$matches" >&2
  exit 1
fi

if git rev-parse --verify --quiet HEAD >/dev/null; then
  history_matches="$(git log -p --all -- . | rg -n "$pattern" || true)"
  if [[ -n "$history_matches" ]]; then
    echo "error: possible credential material found in Git history:" >&2
    echo "$history_matches" >&2
    exit 1
  fi
fi
