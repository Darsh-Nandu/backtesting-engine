"""FastAPI application: REST API + static dashboard."""
from __future__ import annotations

import inspect
import json
import os
import threading
import time
import traceback
import uuid
from pathlib import Path
from urllib.parse import urlparse

import pandas as pd
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.engine import charting
from backend.engine import data as datamod
from backend.engine.compare import compare as run_compare
from backend.engine.costs import COST_MODELS
from backend.engine.indicators import __all__ as INDICATORS
from backend.engine.library import LIBRARY, describe
from backend.engine.markets import MARKETS, get_market
from backend.engine.optimize import OBJECTIVES, optimize, walk_forward
from backend.engine.runner import _arr, _ts, run_backtest
from backend.engine.sandbox import TEMPLATE, StrategyCodeError, load_strategy

from . import store

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "frontend" / "dist"

app = FastAPI(title="QuantForge Backtesting Engine", version="1.0.0")

# The API executes user-written strategy code, so it must only be reachable from this machine's browser:
#  * Host allow-list defeats DNS-rebinding attacks from malicious websites.
#  * Origin check blocks cross-site form posts (CSRF) on state-changing endpoints.
ALLOWED_HOSTS = [h.strip() for h in os.environ.get("QF_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]").split(",") if h.strip()]
DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]
app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS + ["testserver"])
app.add_middleware(CORSMiddleware, allow_origins=DEV_ORIGINS, allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def same_origin_writes(request: Request, call_next):
    origin = request.headers.get("origin")
    if request.method not in ("GET", "HEAD", "OPTIONS") and origin and "*" not in ALLOWED_HOSTS:
        host = urlparse(origin).hostname or ""
        if origin not in DEV_ORIGINS and host not in ("localhost", "127.0.0.1", "::1") and host not in ALLOWED_HOSTS:
            return JSONResponse(status_code=403, content={"detail": "Cross-origin request blocked"})
    return await call_next(request)


@app.exception_handler(StrategyCodeError)
async def _code_err(_, e: StrategyCodeError):
    return JSONResponse(status_code=400, content={"detail": str(e), "line": e.line})


@app.exception_handler(datamod.DataError)
async def _data_err(_, e: datamod.DataError):
    return JSONResponse(status_code=400, content={"detail": str(e)})


@app.exception_handler(ValueError)
async def _val_err(_, e: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(e)})


def _fast_json(obj) -> Response:
    """Serialise large, already-clean payloads directly (FastAPI's encoder is slow on 100k-element lists)."""
    return Response(content=json.dumps(obj, separators=(",", ":"), allow_nan=False), media_type="application/json")


def _inject_custom_code(req: dict) -> dict:
    spec = req.get("strategy") or {}
    sid = spec.get("id") or ""
    if sid.startswith("custom:") and not spec.get("code"):
        code = store.get_strategy_code(sid.split(":", 1)[1])
        if code is None:
            raise HTTPException(404, f"Custom strategy {sid} not found")
        req["strategy"] = {**spec, "code": code}
    return req


# --------------------------------------------------------------------------- #
# Metadata
# --------------------------------------------------------------------------- #
@app.get("/api/meta")
def meta():
    return {
        "markets": [m.to_dict() for m in MARKETS.values()],
        "intervals": datamod.INTERVALS,
        "intraday_limits": datamod.INTRADAY_LIMIT_DAYS,
        "cost_models": COST_MODELS,
        "objectives": [{"id": k, "label": v} for k, v in OBJECTIVES.items()],
        "indicators": INDICATORS,
        "template": TEMPLATE,
    }


@app.get("/api/strategies")
def strategies():
    lib = []
    for key, cls in LIBRARY.items():
        try:
            src = inspect.getsource(cls)
        except (OSError, TypeError):
            src = None
        lib.append(describe(cls, key, src))
    custom = []
    for s in store.list_strategies():
        try:
            cls = load_strategy(s["code"])
            d = describe(cls, s["id"], s["code"])
            d["category"] = "My strategies"
            d["name"] = s.get("name") or d["name"]
            custom.append(d)
        except StrategyCodeError as e:
            custom.append({"id": s["id"], "name": s.get("name"), "category": "My strategies",
                           "description": f"⚠ {e}", "params": {}, "per_asset": True, "source": s["code"],
                           "broken": True})
    return custom + lib


class CodeIn(BaseModel):
    code: str
    name: str | None = None


@app.post("/api/strategies/validate")
def validate(body: CodeIn):
    cls = load_strategy(body.code)
    return describe(cls, "custom", body.code)


@app.post("/api/strategies/custom")
def save_custom(body: CodeIn):
    cls = load_strategy(body.code)
    return store.save_strategy(body.name or cls.name, body.code)


@app.delete("/api/strategies/custom/{slug}")
def delete_custom(slug: str):
    if not store.delete_strategy(slug):
        raise HTTPException(404, "Not found")
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Data
# --------------------------------------------------------------------------- #
@app.get("/api/symbols/search")
def symbol_search(q: str):
    if len(q.strip()) < 1:
        return []
    return datamod.search_symbols(q.strip())


# --------------------------------------------------------------------------- #
# Interactive chart
# --------------------------------------------------------------------------- #
@app.get("/api/chart/bars")
def chart_bars(symbol: str, interval: str = "1D"):
    return _fast_json(charting.bars(symbol, interval))


class LayoutBody(BaseModel):
    name: str
    state: dict


@app.get("/api/layouts")
def layouts():
    return store.list_layouts()


@app.post("/api/layouts")
def save_layout(body: LayoutBody):
    if len(json.dumps(body.state)) > 2_000_000:
        raise HTTPException(413, "Layout too large")
    return store.save_layout(body.name, body.state)


@app.get("/api/layouts/{lid}")
def get_layout(lid: str):
    d = store.get_layout(lid)
    if d is None:
        raise HTTPException(404, "Layout not found")
    return d


@app.delete("/api/layouts/{lid}")
def delete_layout(lid: str):
    if not store.delete_layout(lid):
        raise HTTPException(404, "Layout not found")
    return {"ok": True}


@app.get("/api/data/preview")
def data_preview(symbol: str, market: str = "NASDAQ", source: str = "yahoo", start: str | None = None,
                 end: str | None = None, interval: str = "1d", adjusted: bool = True):
    sym, df = datamod.load(source, market, symbol, start, end, interval, adjusted)
    rets = df["close"].pct_change().dropna()
    m = get_market(market)
    ppy = 252 if interval == "1d" else 52 if interval == "1wk" else 12 if interval == "1mo" else 252 * 6
    years = max((df.index[-1] - df.index[0]).days / 365.25, 1e-9)
    stats = {
        "symbol": sym, "rows": len(df), "start": df.index[0].isoformat(), "end": df.index[-1].isoformat(),
        "first": float(df["close"].iloc[0]), "last": float(df["close"].iloc[-1]),
        "return_pct": round(float(df["close"].iloc[-1] / df["close"].iloc[0] - 1) * 100, 2),
        "cagr_pct": round(float((df["close"].iloc[-1] / df["close"].iloc[0]) ** (1 / years) - 1) * 100, 2),
        "volatility_pct": round(float(rets.std() * (ppy ** 0.5) * 100), 2),
        "max_drawdown_pct": round(float((df["close"] / df["close"].cummax() - 1).min() * 100), 2),
        "high": float(df["high"].max()), "low": float(df["low"].min()),
        "avg_volume": float(df["volume"].mean()), "missing_volume_pct": round(float((df["volume"] == 0).mean() * 100), 1),
        "currency": m.currency,
    }
    return _fast_json({"stats": stats, "t": _ts(df.index), "open": _arr(df["open"]), "high": _arr(df["high"]),
            "low": _arr(df["low"]), "close": _arr(df["close"]), "volume": _arr(df["volume"], 0)})


@app.post("/api/data/upload")
async def upload(file: UploadFile = File(...)):
    content = await file.read()
    if len(content) > 100 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 100MB)")
    return datamod.save_upload(file.filename or "upload.csv", content)


@app.get("/api/data/uploads")
def uploads():
    return datamod.list_uploads()


@app.delete("/api/data/uploads/{name}")
def delete_upload(name: str):
    if not datamod.delete_upload(name):
        raise HTTPException(404, "Not found")
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Backtests & history
# --------------------------------------------------------------------------- #
@app.post("/api/backtest")
def backtest(req: dict):
    req = _inject_custom_code(req)
    try:
        result = run_backtest(req)
    except (StrategyCodeError, datamod.DataError, ValueError, HTTPException):
        raise
    except Exception as e:
        tb = traceback.format_exc(limit=6)
        raise HTTPException(500, f"{type(e).__name__}: {e}\n{tb}")
    if req.get("save", True):
        store.save_run(result)
    return _fast_json(result)


@app.post("/api/compare")
def compare(req: dict):
    """Run several strategies on the same data and settings. Not saved to history."""
    specs = []
    for spec in req.get("strategies") or []:
        specs.append(_inject_custom_code({"strategy": dict(spec or {})})["strategy"])
    try:
        return _fast_json(run_compare({**req, "strategies": specs}))
    except (StrategyCodeError, datamod.DataError, ValueError, HTTPException):
        raise
    except Exception as e:
        raise HTTPException(500, f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=6)}")


@app.get("/api/runs")
def runs():
    return store.list_runs()


@app.get("/api/runs/{rid}")
def run_detail(rid: str):
    r = store.get_run(rid)
    if r is None:
        raise HTTPException(404, "Run not found")
    return _fast_json(r)


class RunPatch(BaseModel):
    name: str | None = None
    starred: bool | None = None


@app.patch("/api/runs/{rid}")
def patch_run(rid: str, body: RunPatch):
    store.update_run(rid, body.name, body.starred)
    return {"ok": True}


@app.delete("/api/runs/{rid}")
def remove_run(rid: str):
    if not store.delete_run(rid):
        raise HTTPException(404, "Run not found")
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Background jobs (optimisation / walk-forward)
# --------------------------------------------------------------------------- #
JOBS: dict[str, dict] = {}


def _start_job(kind: str, fn, req: dict) -> dict:
    jid = uuid.uuid4().hex[:10]
    job = {"id": jid, "kind": kind, "status": "running", "progress": 0, "total": 0, "started": time.time(),
           "result": None, "error": None}
    JOBS[jid] = job

    def progress(done, total):
        job["progress"], job["total"] = done, total

    def target():
        try:
            job["result"] = fn(req, progress)
            job["status"] = "done"
        except Exception as e:
            job["status"], job["error"] = "error", f"{type(e).__name__}: {e}"
        job["finished"] = time.time()

    threading.Thread(target=target, daemon=True).start()
    # Keep the job table bounded.
    if len(JOBS) > 50:
        for k in sorted(JOBS, key=lambda k: JOBS[k]["started"])[:-50]:
            JOBS.pop(k, None)
    return {"id": jid}


@app.post("/api/optimize")
def start_optimize(req: dict):
    return _start_job("optimize", optimize, _inject_custom_code(req))


@app.post("/api/walkforward")
def start_walkforward(req: dict):
    return _start_job("walkforward", walk_forward, _inject_custom_code(req))


@app.get("/api/jobs/{jid}")
def job_status(jid: str):
    job = JOBS.get(jid)
    if not job:
        raise HTTPException(404, "Job not found")
    out = {k: v for k, v in job.items() if k != "result"}
    out["elapsed"] = round((job.get("finished") or time.time()) - job["started"], 1)
    if job["status"] == "done":
        out["result"] = job["result"]
    return _fast_json(out)


@app.get("/api/health")
def health():
    return {"ok": True, "frontend_built": DIST.exists()}


# --------------------------------------------------------------------------- #
# Static SPA
# --------------------------------------------------------------------------- #
if (DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")


@app.get("/{path:path}", include_in_schema=False)
def spa(path: str):
    target = (DIST / path).resolve()
    if path and target.is_file() and target.is_relative_to(DIST.resolve()):
        return FileResponse(target)
    index = DIST / "index.html"
    if index.exists():
        # Hashed assets are cacheable forever; index.html must always be revalidated.
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
    return JSONResponse({"message": "Frontend not built. Run: cd frontend && npm install && npm run build"},
                        status_code=503)
