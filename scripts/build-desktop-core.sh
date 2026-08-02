#!/bin/zsh
set -euo pipefail

project_root="${0:A:h:h}"
cd "$project_root"

npm --prefix dashboard run build
uv run --group desktop pyinstaller \
  --clean \
  --noconfirm \
  --distpath "$project_root/dist/desktop-core" \
  --workpath "$project_root/build/pyinstaller" \
  "$project_root/packaging/restork-core.spec"

core_binary="$project_root/dist/desktop-core/restork-core/restork-core"
test -x "$core_binary"
print -r -- "$core_binary"
