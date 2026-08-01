#!/usr/bin/env bash
set -euo pipefail

if ! command -v grep >/dev/null 2>&1; then
  echo "error: grep is required for the public artifact scan" >&2
  exit 2
fi

pattern='(gh[pous]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|DEEPSEEK_API_KEY[[:space:]]*=)'

matches="$(find . -type f \
  ! -path './.git/*' \
  ! -path './.venv/*' \
  ! -path './dashboard/node_modules/*' \
  ! -path './tests/fixtures/*' \
  ! -name '*.lock' \
  -exec grep -E -I -n -H "$pattern" {} + 2>/dev/null || true)"

if [[ -n "$matches" ]]; then
  echo "error: possible credential material found in public artifacts:" >&2
  echo "$matches" >&2
  exit 1
fi

if git rev-parse --verify --quiet HEAD >/dev/null; then
  history_matches="$(git log -p --all -- . | grep -E -n "$pattern" || true)"
  if [[ -n "$history_matches" ]]; then
    echo "error: possible credential material found in Git history:" >&2
    echo "$history_matches" >&2
    exit 1
  fi
fi
