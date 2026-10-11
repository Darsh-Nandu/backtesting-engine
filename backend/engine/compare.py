"""Strategy comparison: run several strategies on the same data, costs and rules, side by side."""
from __future__ import annotations

import os
import time
import uuid
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone

import pandas as pd

from .core import Backtester
from .markets import get_market
from .metrics import compute_metrics, monthly_returns, periods_per_year, yearly_returns
from .runner import (_arr, _clean, _ts, build_config, coerce_params, explain_no_trades, load_benchmark,
                     load_frames, resolve_strategy)

MAX_STRATEGIES = 8
TRADE_KEYS = ("symbol", "side", "entry_time", "exit_time", "pnl", "return_pct", "fees", "exit_reason", "bars_held")


def _run_one(frames, spec: dict, cfg) -> dict:
    """Run one strategy. Top-level so it can execute in a worker process."""
    try:
        cls = resolve_strategy(spec)
        params = coerce_params(cls, spec.get("params"))
        res = Backtester(frames, cls, params, cfg).run()
        return {"ok": True, "cls_name": cls.name, "category": cls.category, "params": {**cls.params, **params},
                "equity": res["equity"], "exposure": res["exposure"], "trades": res["trades"], "fees": res["fees"],
                "why": explain_no_trades(cls, cfg, res), "elapsed": res["elapsed"]}
    except Exception as e:  # one broken strategy shouldn't sink the whole comparison
        return {"ok": False, "error": str(e) or type(e).__name__}


def _run_all(frames, specs: list[dict], cfg) -> list[dict]:
    bars = sum(len(f) for f in frames.values())
    workers = max(1, min((os.cpu_count() or 2) - 1, len(specs)))
    # Process start-up costs ~0.3 s, so only fan out when there's real work.
    if workers > 1 and bars * len(specs) > 20_000:
        try:
            with ProcessPoolExecutor(max_workers=workers) as ex:
                return list(ex.map(_run_one, [frames] * len(specs), specs, [cfg] * len(specs)))
        except Exception:
            pass
    return [_run_one(frames, s, cfg) for s in specs]


def _bench_equity(bm, index, capital):
    if bm is None:
        return None
    b = bm.reindex(index).ffill().bfill()
    if not b.notna().any() or b.iloc[0] <= 0:
        return None
    return b / b.iloc[0] * capital


def _entry(label, sid, eq, trades, exposure, fees, cfg, bench_eq, **extra) -> dict:
    m = compute_metrics(eq, trades, cfg.periods_per_year, cfg.risk_free_rate, bench_eq, exposure, fees)
    m.pop("_drawdowns", None)
    return {
        "label": label, "id": sid, "metrics": m,
        "equity": _arr(eq, 2), "exposure": _arr(exposure * 100, 1) if exposure is not None else None,
        "monthly": monthly_returns(eq), "yearly": yearly_returns(eq),
        "trades": [{k: (int(pd.Timestamp(tr[k]).timestamp()) if k.endswith("_time") else tr.get(k)) for k in TRADE_KEYS}
                   for tr in trades],
        **extra,
    }


def compare(req: dict) -> dict:
    t0 = time.perf_counter()
    specs = [s for s in (req.get("strategies") or []) if s and (s.get("id") or s.get("code"))]
    if len(specs) < 2:
        raise ValueError("Pick at least two strategies to compare")
    if len(specs) > MAX_STRATEGIES:
        raise ValueError(f"Compare at most {MAX_STRATEGIES} strategies at a time")

    market = get_market(req.get("market"))
    frames, warnings = load_frames(req)
    first_index = next(iter(frames.values())).index
    ppy = periods_per_year(first_index, req.get("interval", "1d"), market.trading_days)
    cfg = build_config(req, market, ppy)
    bm_name, bm = load_benchmark(req, frames)

    runs = _run_all(frames, specs, cfg)
    index = next((r["equity"].index for r in runs if r["ok"]), None)
    if index is None:
        raise ValueError("Every strategy failed: " + "; ".join(r["error"] for r in runs))
    bench_eq = _bench_equity(bm, index, cfg.initial_capital)

    entries, rets, seen = [], {}, set()
    for spec, r in zip(specs, runs):
        label = (spec.get("label") or "").strip() or r.get("cls_name") or spec.get("id")
        base, k = label, 2
        while label in seen:  # labels key the blend and the charts, so keep them unique
            label, k = f"{base} #{k}", k + 1
        seen.add(label)
        if not r["ok"]:
            entries.append({"label": label, "id": spec.get("id"), "error": r["error"]})
            continue
        e = _entry(label, spec.get("id"), r["equity"], r["trades"], r["exposure"], r["fees"], cfg, bench_eq,
                   name=r["cls_name"], category=r["category"], params=r["params"],
                   note=r["why"], elapsed_ms=round(r["elapsed"] * 1000, 1))
        entries.append(e)
        rets[label] = r["equity"].pct_change().fillna(0.0)

    # Equal-weight blend, rebalanced every bar: what you'd get splitting capital evenly across the strategies.
    blend = None
    if len(rets) >= 2:
        br = pd.DataFrame(rets).mean(axis=1)
        beq = (1 + br).cumprod() * cfg.initial_capital
        blend = _entry("Equal-weight blend", None, beq, [], None, 0.0, cfg, bench_eq, is_blend=True)
        blend["trades"] = None

    return _clean({
        "id": uuid.uuid4().hex[:12],
        "created": datetime.now(timezone.utc).isoformat(),
        "request": {k: v for k, v in req.items() if k != "refresh"},
        "market": market.to_dict(),
        "currency": market.currency if req.get("source") != "csv" else req.get("currency", market.currency),
        "t": _ts(index),
        "benchmark": _arr(bench_eq, 2) if bench_eq is not None else None,
        "benchmark_name": bm_name,
        "strategies": entries,
        "blend": blend,
        "warnings": warnings,
        "config": {"periods_per_year": cfg.periods_per_year, "cost_model": cfg.cost.kind,
                   "fill_on": cfg.fill_on, "initial_capital": cfg.initial_capital},
        "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1),
    })
