#!/usr/bin/env bash

# Clean-runner lifecycle check for the public Linux technical preview.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 /path/to/Restork.AppImage /path/to/Restork.deb" >&2
  exit 2
fi

appimage=$(realpath "$1")
deb=$(realpath "$2")
test -f "$appimage" && test -f "$deb"

smoke_root=$(mktemp -d "${TMPDIR:-/tmp}/restork-linux-smoke.XXXXXX")
original_home=${HOME:?}
cleanup() {
  HOME=$original_home
  case "$smoke_root" in
    "${TMPDIR:-/tmp}"/restork-linux-smoke.*) ;;
    *)
      echo "refusing to remove unexpected smoke directory: $smoke_root" >&2
      return
      ;;
  esac
  rm -rf -- "$smoke_root"
}
trap cleanup EXIT

export HOME="$smoke_root/home"
mkdir -p "$HOME"
diagnostics="$HOME/.local/share/io.github.totoro-qaq.restork/logs/desktop-events.jsonl"

launch_and_wait() {
  local label=$1
  shift
  rm -f "$diagnostics"
  setsid dbus-run-session -- xvfb-run -a "$@" >"$smoke_root/$label.stdout" 2>"$smoke_root/$label.stderr" &
  local desktop_pid=$!
  local ready=0
  for _attempt in $(seq 1 160); do
    if ! kill -0 "$desktop_pid" 2>/dev/null; then
      cat "$smoke_root/$label.stderr" >&2 || true
      echo "$label exited before the Dashboard paired with Core" >&2
      return 1
    fi
    if [[ -f "$diagnostics" ]] && grep -q '"event":"browser_session_stored"' "$diagnostics"; then
      ready=1
      break
    fi
    sleep 0.25
  done
  if [[ "$ready" -ne 1 ]]; then
    cat "$smoke_root/$label.stderr" >&2 || true
    echo "$label did not become ready" >&2
    kill -- "-$desktop_pid" 2>/dev/null || true
    wait "$desktop_pid" 2>/dev/null || true
    return 1
  fi
  kill -- "-$desktop_pid" 2>/dev/null || true
  wait "$desktop_pid" 2>/dev/null || true
  sleep 1
  if pgrep -x restorkd >/dev/null; then
    echo "$label left a Restork Core process running" >&2
    pgrep -ax restorkd >&2 || true
    return 1
  fi
}

chmod +x "$appimage"
launch_and_wait appimage "$appimage" --appimage-extract-and-run

sudo apt-get install -y "$deb"
launch_and_wait deb restork

data="$HOME/.local/share/io.github.totoro-qaq.restork"
mkdir -p "$data"
printf '%s\n' preserve >"$data/clean-machine-sentinel"
sudo apt-get remove -y restork
test -f "$data/clean-machine-sentinel"

echo "Linux AppImage and DEB clean-machine smoke passed."
