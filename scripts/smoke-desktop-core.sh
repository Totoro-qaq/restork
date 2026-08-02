#!/bin/zsh
set -euo pipefail

project_root="${0:A:h:h}"
core_binary="${1:-$project_root/dist/desktop-core/restork-core/restork-core}"

if [[ ! -x "$core_binary" ]]; then
  print -u2 -- "Frozen Core is missing or not executable: $core_binary"
  exit 2
fi

smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/restork-core-smoke.XXXXXX")"
chmod 700 "$smoke_root"
core_pid=""

cleanup() {
  if [[ -n "$core_pid" ]] && kill -0 "$core_pid" 2>/dev/null; then
    kill -TERM "$core_pid" 2>/dev/null || true
    wait "$core_pid" 2>/dev/null || true
  fi
  if [[ -n "$smoke_root" && "$smoke_root" == *restork-core-smoke.* ]]; then
    /bin/rm -rf -- "$smoke_root"
  fi
}
trap cleanup EXIT INT TERM

config_dir="$smoke_root/config"
data_dir="$smoke_root/data"
cache_dir="$smoke_root/cache"
bootstrap_dir="$smoke_root/bootstrap"
mkdir -p "$config_dir" "$data_dir" "$cache_dir" "$bootstrap_dir"
chmod 700 "$config_dir" "$data_dir" "$cache_dir" "$bootstrap_dir"

port="$(/usr/bin/python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
bootstrap_path="$bootstrap_dir/core.json"
stdout_path="$smoke_root/core.stdout"
stderr_path="$smoke_root/core.stderr"

RESTORK_CONFIG_DIR="$config_dir" \
RESTORK_DATA_DIR="$data_dir" \
RESTORK_CACHE_DIR="$cache_dir" \
RESTORK_DESKTOP_BOOTSTRAP_PATH="$bootstrap_path" \
  "$core_binary" \
    --state-db "$data_dir/restork.db" \
    serve \
    --port "$port" \
    >"$stdout_path" \
    2>"$stderr_path" &
core_pid=$!

ready=0
for _attempt in {1..120}; do
  if curl --fail --silent --max-time 1 \
    "http://127.0.0.1:$port/v1/readiness" \
    >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$core_pid" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

if [[ "$ready" != "1" ]]; then
  print -u2 -- "Frozen Core did not become ready."
  tail -n 30 "$stderr_path" >&2 || true
  exit 1
fi

if [[ ! -f "$bootstrap_path" ]]; then
  print -u2 -- "Frozen Core did not publish a desktop bootstrap."
  exit 1
fi

if [[ "$(stat -f '%Lp' "$bootstrap_path")" != "600" ]]; then
  print -u2 -- "Desktop bootstrap permissions are not 0600."
  exit 1
fi

/usr/bin/python3 - "$bootstrap_path" "$port" "$core_pid" <<'PY'
import json
import pathlib
import sys

payload = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
assert payload["schema_version"] == 1
assert payload["port"] == int(sys.argv[2])
assert payload["pid"] == int(sys.argv[3])
assert isinstance(payload["pairing_code"], str)
assert len(payload["pairing_code"]) >= 16
PY

if [[ -s "$stdout_path" ]]; then
  print -u2 -- "Frozen Core wrote unexpected desktop-mode stdout."
  exit 1
fi

print -r -- "Frozen Core smoke test passed on 127.0.0.1:$port"
