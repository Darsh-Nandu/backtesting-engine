"""Launch QuantForge: builds the dashboard if needed and starts the API server.

    uv run python run.py [--port 8000] [--host 127.0.0.1] [--rebuild] [--no-browser]
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FRONTEND = ROOT / "frontend"


def build_frontend(force: bool = False) -> None:
    if (FRONTEND / "dist" / "index.html").exists() and not force:
        return
    npm = shutil.which("npm")
    if not npm:
        print("! npm not found - install Node.js 18+ to build the dashboard (API will still run).")
        return
    if not (FRONTEND / "node_modules").exists():
        print("> Installing dashboard dependencies (first run only)...")
        subprocess.run([npm, "install"], cwd=FRONTEND, check=True)
    print("> Building dashboard...")
    subprocess.run([npm, "run", "build"], cwd=FRONTEND, check=True)


def main() -> None:
    ap = argparse.ArgumentParser(description="QuantForge backtesting engine")
    ap.add_argument("--host", default="127.0.0.1",
                    help="Bind address. Keep localhost: the API executes user strategy code.")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--rebuild", action="store_true", help="Force a rebuild of the dashboard")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--reload", action="store_true", help="Auto-reload the API on code changes")
    args = ap.parse_args()

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("! WARNING: binding to a non-local address exposes custom strategy code execution to your network.")
        hosts = os.environ.get("QF_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]")
        os.environ["QF_ALLOWED_HOSTS"] = "*" if args.host == "0.0.0.0" else f"{hosts},{args.host}"
    build_frontend(args.rebuild)
    url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}"
    print(f"\n  QuantForge is running at {url}\n")
    if not args.no_browser:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()

    import uvicorn
    sys.path.insert(0, str(ROOT))
    uvicorn.run("backend.api.main:app", host=args.host, port=args.port, reload=args.reload, log_level="info")


if __name__ == "__main__":
    main()
