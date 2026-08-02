#!/bin/zsh
set -euo pipefail

project_root="${0:A:h:h}"
app_bundle="${1:-$project_root/desktop/src-tauri/target/release/bundle/macos/Restork.app}"
main_binary="$app_bundle/Contents/MacOS/restork"
core_binary="$app_bundle/Contents/Resources/core/restork-core/restork-core"
diagnostics="$HOME/Library/Logs/io.github.totoro-qaq.restork/desktop-events.jsonl"
desktop_pid=""
core_pid=""

if [[ ! -x "$main_binary" || ! -x "$core_binary" ]]; then
  print -u2 -- "Built Restork.app is missing its desktop or Core executable."
  exit 2
fi

find_desktop_pid() {
  /bin/ps -axo pid=,command= | /usr/bin/awk -v target="$main_binary" \
    '$2 == target && NF == 2 { print $1; exit }'
}

find_core_pid() {
  /bin/ps -axo pid=,command= | /usr/bin/awk -v target="$core_binary" \
    '$2 == target { print $1; exit }'
}

exact_process_running() {
  local selected_pid="$1"
  local selected_binary="$2"
  [[ -n "$selected_pid" ]] || return 1
  /bin/ps -p "$selected_pid" -o command= 2>/dev/null \
    | /usr/bin/awk -v target="$selected_binary" '$1 == target { found = 1 } END { exit !found }'
}

quit_owned_processes() {
  /usr/bin/osascript -e 'tell application "Restork" to quit' >/dev/null 2>&1 || true
  for _attempt in {1..60}; do
    desktop_pid="$(find_desktop_pid)"
    core_pid="$(find_core_pid)"
    if [[ -z "$desktop_pid" && -z "$core_pid" ]]; then
      return 0
    fi
    sleep 0.1
  done
  if exact_process_running "$core_pid" "$core_binary"; then
    /bin/kill -CONT "$core_pid" >/dev/null 2>&1 || true
    /bin/kill -KILL "$core_pid" >/dev/null 2>&1 || true
  fi
  if exact_process_running "$desktop_pid" "$main_binary"; then
    /bin/kill -KILL "$desktop_pid" >/dev/null 2>&1 || true
  fi
  return 1
}

diagnostic_lines() {
  if [[ -f "$diagnostics" ]]; then
    /usr/bin/wc -l < "$diagnostics" | /usr/bin/tr -d ' '
  else
    print -r -- 0
  fi
}

wait_for_event() {
  local after_line="$1"
  local event="$2"
  local attempts="$3"
  for (( attempt = 1; attempt <= attempts; attempt++ )); do
    if [[ -f "$diagnostics" ]] && /usr/bin/tail -n "+$((after_line + 1))" "$diagnostics" \
      | /usr/bin/grep -q "\"event\":\"$event\""; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

launch_ready_app() {
  local start_line
  start_line="$(diagnostic_lines)"
  /usr/bin/open "$app_bundle"
  if ! wait_for_event "$start_line" "browser_session_stored" 120; then
    print -u2 -- "Desktop session did not become ready."
    return 1
  fi
  desktop_pid="$(find_desktop_pid)"
  core_pid="$(find_core_pid)"
  if ! exact_process_running "$desktop_pid" "$main_binary" \
    || ! exact_process_running "$core_pid" "$core_binary"; then
    print -u2 -- "Could not resolve the exact owned desktop/Core process pair."
    return 1
  fi
  local actual_parent
  actual_parent="$(/bin/ps -p "$core_pid" -o ppid= | /usr/bin/tr -d ' ')"
  if [[ "$actual_parent" != "$desktop_pid" ]]; then
    print -u2 -- "Core is not owned by the expected Rust supervisor."
    return 1
  fi
}

trap 'quit_owned_processes || true' EXIT INT TERM
if ! quit_owned_processes; then
  print -u2 -- "An existing Restork process did not stop cleanly."
  exit 1
fi

launch_ready_app
heartbeat_line="$(diagnostic_lines)"
/bin/kill -STOP "$core_pid"
if ! wait_for_event "$heartbeat_line" "core_heartbeat_failed" 140; then
  print -u2 -- "Rust supervisor did not fail a frozen Core after the heartbeat budget."
  exit 1
fi
for _attempt in {1..30}; do
  if ! exact_process_running "$core_pid" "$core_binary"; then
    break
  fi
  sleep 0.1
done
if exact_process_running "$core_pid" "$core_binary"; then
  print -u2 -- "Frozen Core survived the bounded TERM/KILL cleanup."
  exit 1
fi
if ! exact_process_running "$desktop_pid" "$main_binary"; then
  print -u2 -- "Desktop exited instead of presenting native recovery."
  exit 1
fi
print -r -- "Heartbeat fault passed: frozen Core was detected, reclaimed, and surfaced for retry."

if ! quit_owned_processes; then
  print -u2 -- "Desktop did not quit after heartbeat recovery state."
  exit 1
fi
launch_ready_app
/bin/kill -KILL "$desktop_pid"
for _attempt in {1..50}; do
  if ! exact_process_running "$core_pid" "$core_binary"; then
    break
  fi
  sleep 0.1
done
if exact_process_running "$core_pid" "$core_binary"; then
  print -u2 -- "Core survived loss of its Rust parent lease."
  exit 1
fi
print -r -- "Parent-loss fault passed: kernel lease EOF stopped Core after Rust SIGKILL."
