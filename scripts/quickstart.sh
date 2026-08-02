#!/bin/sh

set -eu

if ! command -v uv >/dev/null 2>&1; then
  printf '%s\n' 'Restork needs uv: https://docs.astral.sh/uv/getting-started/installation/' >&2
  printf '%s\n' 'Restork 需要先安装 uv：见上方官方安装文档。' >&2
  exit 1
fi

restork_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
restork_port=${RESTORK_PORT:-7337}

case "$restork_port" in
  ''|*[!0-9]*)
    printf '%s\n' 'RESTORK_PORT must be an integer from 1 to 65535.' >&2
    exit 2
    ;;
esac

if [ "$restork_port" -lt 1 ] || [ "$restork_port" -gt 65535 ]; then
  printf '%s\n' 'RESTORK_PORT must be an integer from 1 to 65535.' >&2
  exit 2
fi

cd "$restork_root"

printf '%s\n' 'Preparing the locked Restork environment…'
uv sync --frozen

printf '\n%s\n' "Dashboard: http://127.0.0.1:$restork_port"
printf '%s\n' 'Enter the Web pairing code printed below. Press Ctrl-C to stop Restork.'
printf '%s\n\n' '请在浏览器输入下方 Web 配对码；按 Ctrl-C 停止 Restork。'

exec uv run restork "$@" serve --port "$restork_port"
