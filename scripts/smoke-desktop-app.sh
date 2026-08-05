#!/bin/zsh
set -euo pipefail

project_root="${0:A:h:h}"
iterations="${1:-5}"
app_bundle="${2:-$project_root/desktop/src-tauri/target/release/bundle/macos/Restork.app}"
main_binary="$app_bundle/Contents/MacOS/restork"
core_binary="$app_bundle/Contents/Resources/core/restorkd"
diagnostics="$HOME/Library/Logs/io.github.totoro-qaq.restork/desktop-events.jsonl"

if [[ ! "$iterations" =~ '^[1-9][0-9]*$' || "$iterations" -gt 50 ]]; then
  print -u2 -- "Iteration count must be between 1 and 50."
  exit 2
fi
if [[ ! -x "$main_binary" || ! -x "$core_binary" ]]; then
  print -u2 -- "Built Restork.app is missing its desktop or Core executable."
  exit 2
fi

desktop_running() {
  /bin/ps -axo command= | /usr/bin/awk -v target="$main_binary" '$0 == target { found = 1 } END { exit !found }'
}

core_running() {
  /bin/ps -axo command= | /usr/bin/awk -v target="$core_binary" '$1 == target { found = 1 } END { exit !found }'
}

quit_app() {
  /usr/bin/osascript -e 'tell application "Restork" to quit' >/dev/null 2>&1 || true
  for _attempt in {1..60}; do
    if ! desktop_running && ! core_running; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

trap 'quit_app || true' EXIT INT TERM
if ! quit_app; then
  print -u2 -- "An existing Restork process did not stop."
  exit 1
fi

typeset -a durations
for (( iteration = 1; iteration <= iterations; iteration++ )); do
  line_count=0
  if [[ -f "$diagnostics" ]]; then
    line_count="$(/usr/bin/wc -l < "$diagnostics" | /usr/bin/tr -d ' ')"
  fi
  started_ms="$(/usr/bin/python3 -c 'import time; print(round(time.time() * 1000))')"
  # LaunchServices can briefly retain a terminated app registration and turn a
  # second plain `open` into a no-op. Force a fresh process for every lifecycle
  # iteration so the smoke test measures Restork rather than that cache window.
  /usr/bin/open -n "$app_bundle"
  ready=0
  desktop_seen=0
  for _attempt in {1..120}; do
    if [[ -f "$diagnostics" ]] && /usr/bin/tail -n "+$((line_count + 1))" "$diagnostics" \
      | /usr/bin/grep -q '"event":"browser_session_stored"'; then
      ready=1
      break
    fi
    if desktop_running; then
      desktop_seen=1
    elif [[ "$desktop_seen" == "1" ]]; then
      break
    fi
    sleep 0.1
  done
  if [[ "$ready" != "1" ]]; then
    print -u2 -- "Desktop session did not become ready on launch $iteration."
    exit 1
  fi
  completed_ms="$(/usr/bin/python3 -c 'import time; print(round(time.time() * 1000))')"
  duration="$((completed_ms - started_ms))"
  durations+=("$duration")
  if ! quit_app; then
    print -u2 -- "Restork left an owned desktop/Core process after launch $iteration."
    exit 1
  fi
  print -r -- "Desktop launch $iteration ready in ${duration} ms; quit left no owned process."
done

/usr/bin/python3 - "${durations[@]}" <<'PY'
import math
import sys

values = sorted(int(value) for value in sys.argv[1:])
index = max(0, math.ceil(len(values) * 0.95) - 1)
print(f"Desktop lifecycle smoke passed: launches={len(values)}, p95={values[index]} ms")
PY
