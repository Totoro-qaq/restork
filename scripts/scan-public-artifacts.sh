#!/usr/bin/env bash
set -euo pipefail

python3 "$(dirname "$0")/scan_public_artifacts.py"
