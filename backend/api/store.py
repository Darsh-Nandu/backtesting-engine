"""SQLite-backed run history + file-backed custom strategy library."""
from __future__ import annotations

import json
import re
import sqlite3
import threading
import zlib
from datetime import datetime, timezone
from pathlib import Path

from backend.engine.data import DATA_ROOT

DB_PATH = DATA_ROOT / "runs.db"
STRAT_DIR = DATA_ROOT / "strategies"
STRAT_DIR.mkdir(parents=True, exist_ok=True)
_lock = threading.Lock()

SUMMARY_KEYS = ["total_return_pct", "cagr_pct", "sharpe", "sortino", "max_drawdown_pct", "trades", "win_rate_pct",
                "profit_factor", "calmar", "final_equity", "benchmark_return_pct", "volatility_pct"]


def _conn():
    c = sqlite3.connect(DB_PATH, check_same_thread=False)
    c.execute("""CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, created TEXT, name TEXT, kind TEXT, strategy TEXT, market TEXT, symbols TEXT,
        summary TEXT, payload BLOB, starred INTEGER DEFAULT 0)""")
    return c


def save_run(result: dict, kind: str = "backtest", name: str | None = None) -> str:
    rid = result.get("id")
    req = result.get("request", {})
    summary = {k: result.get("metrics", {}).get(k) for k in SUMMARY_KEYS}
    summary["period"] = [result.get("metrics", {}).get("start"), result.get("metrics", {}).get("end")]
    summary["currency"] = result.get("currency")
    blob = zlib.compress(json.dumps(result, separators=(",", ":")).encode(), 6)
    with _lock, _conn() as c:
        c.execute("INSERT OR REPLACE INTO runs (id, created, name, kind, strategy, market, symbols, summary, payload)"
                  " VALUES (?,?,?,?,?,?,?,?,?)",
                  (rid, result.get("created"), name or result.get("strategy", {}).get("name"), kind,
                   result.get("strategy", {}).get("name"), req.get("market"), ",".join(req.get("symbols", [])),
                   json.dumps(summary), blob))
    return rid


def list_runs(limit: int = 200) -> list[dict]:
    with _lock, _conn() as c:
        rows = c.execute("SELECT id, created, name, kind, strategy, market, symbols, summary, starred FROM runs "
                         "ORDER BY created DESC LIMIT ?", (limit,)).fetchall()
    return [{"id": r[0], "created": r[1], "name": r[2], "kind": r[3], "strategy": r[4], "market": r[5],
             "symbols": r[6].split(",") if r[6] else [], "summary": json.loads(r[7] or "{}"), "starred": bool(r[8])}
            for r in rows]


def get_run(rid: str) -> dict | None:
    with _lock, _conn() as c:
        row = c.execute("SELECT payload, name, starred FROM runs WHERE id=?", (rid,)).fetchone()
    if not row:
        return None
    out = json.loads(zlib.decompress(row[0]))
    out["name"], out["starred"] = row[1], bool(row[2])
    return out


def update_run(rid: str, name: str | None = None, starred: bool | None = None) -> bool:
    with _lock, _conn() as c:
        if name is not None:
            c.execute("UPDATE runs SET name=? WHERE id=?", (name, rid))
        if starred is not None:
            c.execute("UPDATE runs SET starred=? WHERE id=?", (1 if starred else 0, rid))
        return c.total_changes > 0


def delete_run(rid: str) -> bool:
    with _lock, _conn() as c:
        cur = c.execute("DELETE FROM runs WHERE id=?", (rid,))
        return cur.rowcount > 0


# --------------------------------------------------------------------------- #
# Custom strategies
# --------------------------------------------------------------------------- #
def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:60] or "strategy"


def save_strategy(name: str, code: str) -> dict:
    slug = _slug(name)
    (STRAT_DIR / f"{slug}.py").write_text(code)
    meta = {"name": name, "updated": datetime.now(timezone.utc).isoformat()}
    (STRAT_DIR / f"{slug}.json").write_text(json.dumps(meta))
    return {"id": f"custom:{slug}", "slug": slug, **meta}


def list_strategies() -> list[dict]:
    out = []
    for p in sorted(STRAT_DIR.glob("*.py")):
        meta_p = p.with_suffix(".json")
        meta = json.loads(meta_p.read_text()) if meta_p.exists() else {"name": p.stem}
        out.append({"id": f"custom:{p.stem}", "slug": p.stem, "code": p.read_text(), **meta})
    return out


def get_strategy_code(slug: str) -> str | None:
    p = STRAT_DIR / f"{_slug(slug)}.py"
    return p.read_text() if p.exists() else None


def delete_strategy(slug: str) -> bool:
    ok = False
    for ext in (".py", ".json"):
        p = STRAT_DIR / f"{_slug(slug)}{ext}"
        if p.exists():
            p.unlink()
            ok = True
    return ok
