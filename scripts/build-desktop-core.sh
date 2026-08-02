#!/bin/zsh
set -euo pipefail

project_root="${0:A:h:h}"
exec node "$project_root/scripts/build-desktop-runtime.mjs"
