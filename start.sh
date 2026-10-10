#!/usr/bin/env bash
# One-command launcher: installs Python deps with uv (or pip) and starts QuantForge.
set -euo pipefail
cd "$(dirname "$0")"
if command -v uv >/dev/null 2>&1; then
  uv sync --quiet
  exec uv run python run.py "$@"
else
  python3 -m venv .venv
  . .venv/bin/activate
  pip install -q fastapi "uvicorn[standard]" pandas numpy yfinance python-multipart
  exec python run.py "$@"
fi
