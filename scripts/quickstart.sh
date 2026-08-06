#!/bin/sh

# Starts the native Rust Core shipped by the desktop application.

set -eu

if ! command -v cargo >/dev/null 2>&1; then
  printf '%s\n' 'Restork needs a Rust toolchain: https://rustup.rs' >&2
  printf '%s\n' 'Restork 需要先安装 Rust 工具链：见上方 rustup 官方文档。' >&2
  exit 1
fi

restork_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
restork_port=${RESTORK_PORT:-0}

case "$restork_port" in
  ''|*[!0-9]*)
    printf '%s\n' 'RESTORK_PORT must be an integer from 0 to 65535.' >&2
    exit 2
    ;;
esac

if [ "$restork_port" -lt 0 ] || [ "$restork_port" -gt 65535 ]; then
  printf '%s\n' 'RESTORK_PORT must be an integer from 0 to 65535.' >&2
  exit 2
fi

cd "$restork_root"

# The Dashboard is embedded into the binary, so it must be built first.
if command -v npm >/dev/null 2>&1; then
  printf '%s\n' 'Building the Dashboard…'
  npm --prefix dashboard ci --silent
  npm --prefix dashboard run build --silent
else
  printf '%s\n' 'npm is unavailable; using the Dashboard bundle already embedded in restork-api.' >&2
fi

printf '%s\n' 'Building the Restork Core…'
cargo build --release --manifest-path rust/Cargo.toml -p restorkd

printf '\n%s\n' 'Open the Dashboard URL printed below and enter its Web pairing code.'
printf '%s\n' 'Press Ctrl-C to stop Restork.'
printf '%s\n\n' '请在浏览器输入下方配对码；按 Ctrl-C 停止 Restork。'

exec ./rust/target/release/restorkd serve --port "$restork_port" "$@"
