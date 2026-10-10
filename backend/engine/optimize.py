"""Parameter optimisation (grid / random search) and walk-forward analysis."""
from __future__ import annotations

import itertools
import math
import os
import random
from concurrent.futures import ProcessPoolExecutor, as_completed
from typing import Callable

import numpy as np
import pandas as pd

from .core import Backtester, EngineConfig
from .metrics import compute_metrics
from .runner import (_arr, _clean, _ts, build_config, coerce_params, load_benchmark, load_frames,
                     resolve_strategy)
from .markets import get_market
from .metrics import periods_per_year

MAX_COMBOS = 5000
OBJECTIVES = {
    "sharpe": "Sharpe ratio", "sortino": "Sortino ratio", "calmar": "Calmar ratio",
    "cagr_pct": "CAGR %", "total_return_pct": "Total return %", "profit_factor": "Profit factor",
    "max_drawdown_pct": "Max drawdown (smaller is better)", "win_rate_pct": "Win rate %", "sqn": "SQN",
    "recovery_factor": "Recovery factor", "expectancy": "Expectancy",
}
KEEP = ["total_return_pct", "cagr_pct", "sharpe", "sortino", "calmar", "max_drawdown_pct", "trades",
        "win_rate_pct", "profit_factor", "sqn", "expectancy", "recovery_factor", "volatility_pct", "exposure_pct"]


# --------------------------------------------------------------------------- #
# Parameter grids
# --------------------------------------------------------------------------- #
def _values(spec, default):
    if isinstance(spec, list):
        return spec
    if not isinstance(spec, dict):
        return [default]
    if spec.get("values"):
        return list(spec["values"])
    lo, hi = float(spec.get("min", default)), float(spec.get("max", default))
    step = float(spec.get("step") or 1)
    if step <= 0 or hi < lo:
        return [default]
    n = int(math.floor((hi - lo) / step + 1e-9)) + 1
    vals = [lo + k * step for k in range(min(n, 500))]
    if isinstance(default, bool):
        return [True, False]
    if isinstance(default, int):
        return sorted({int(round(v)) for v in vals})
    return [round(v, 6) for v in vals]


def build_grid(cls, ranges: dict, method: str = "grid", n_iter: int = 100, seed: int = 0) -> list[dict]:
    keys = [k for k in ranges if k in cls.params]
    axes = [_values(ranges[k], cls.params[k]) for k in keys]
    if not keys:
        return [{}]
    total = math.prod(len(a) for a in axes)
    if method == "random" or total > MAX_COMBOS:
        rng = random.Random(seed)
        n = min(n_iter if method == "random" else MAX_COMBOS, total)
        seen, combos = set(), []
        while len(combos) < n:
            c = tuple(rng.choice(a) for a in axes)
            if c not in seen:
                seen.add(c)
                combos.append(c)
    else:
        combos = list(itertools.product(*axes))
    return [dict(zip(keys, c)) for c in combos]


# --------------------------------------------------------------------------- #
# Worker
# --------------------------------------------------------------------------- #
_W: dict = {}


def _init_worker(frames, strategy_spec, cfg, rf):
    _W["frames"] = frames
    _W["cls"] = resolve_strategy(strategy_spec)
    _W["cfg"] = cfg
    _W["rf"] = rf


def _evaluate(params: dict, frames=None, cls=None, cfg=None) -> dict:
    frames = frames if frames is not None else _W["frames"]
    cls = cls or _W["cls"]
    cfg = cfg or _W["cfg"]
    try:
        res = Backtester(frames, cls, params, cfg).run()
        m = compute_metrics(res["equity"], res["trades"], cfg.periods_per_year, cfg.risk_free_rate,
                            None, res["exposure"], res["fees"])
        return {"params": params, "metrics": {k: m.get(k) for k in KEEP}}
    except Exception as e:
        return {"params": params, "error": f"{type(e).__name__}: {e}"}


def _score(m: dict, objective: str, min_trades: int) -> float:
    if not m or (m.get("trades") or 0) < min_trades:
        return -math.inf
    v = m.get(objective)
    if v is None:
        return -math.inf
    return float(v)


def evaluate_many(frames, strategy_spec, cls, cfg, combos, progress: Callable | None = None,
                  workers: int | None = None) -> list[dict]:
    workers = workers or max(1, min((os.cpu_count() or 2) - 1, 8))
    results = []
    if len(combos) < 6 or workers == 1:
        for k, p in enumerate(combos):
            results.append(_evaluate(p, frames, cls, cfg))
            if progress:
                progress(k + 1, len(combos))
        return results
    try:
        with ProcessPoolExecutor(max_workers=workers, initializer=_init_worker,
                                 initargs=(frames, strategy_spec, cfg, cfg.risk_free_rate)) as ex:
            futs = [ex.submit(_evaluate, p) for p in combos]
            for k, f in enumerate(as_completed(futs)):
                results.append(f.result())
                if progress:
                    progress(k + 1, len(combos))
    except Exception:
        results = []
        for k, p in enumerate(combos):
            results.append(_evaluate(p, frames, cls, cfg))
            if progress:
                progress(k + 1, len(combos))
    return results


def _prepare(req: dict):
    market = get_market(req.get("market"))
    spec = req.get("strategy") or {}
    cls = resolve_strategy(spec)
    frames, warnings = load_frames(req)
    first_index = next(iter(frames.values())).index
    ppy = periods_per_year(first_index, req.get("interval", "1d"), market.trading_days)
    cfg = build_config(req, market, ppy)
    return market, spec, cls, frames, cfg, warnings


# --------------------------------------------------------------------------- #
# Optimisation
# --------------------------------------------------------------------------- #
def optimize(req: dict, progress: Callable | None = None) -> dict:
    opt = req.get("optimize") or {}
    objective = opt.get("objective", "sharpe")
    min_trades = int(opt.get("min_trades", 1))
    market, spec, cls, frames, cfg, warnings = _prepare(req)
    base = coerce_params(cls, spec.get("params"))
    combos = build_grid(cls, opt.get("ranges") or {}, opt.get("method", "grid"), int(opt.get("n_iter", 100)))
    combos = [{**base, **coerce_params(cls, c)} for c in combos]
    sign = -1 if objective == "max_drawdown_pct_min" else 1
    results = evaluate_many(frames, spec, cls, cfg, combos, progress)
    for r in results:
        r["score"] = _score(r.get("metrics"), objective, min_trades) * sign
    results.sort(key=lambda r: r["score"], reverse=True)
    varied = [k for k in (opt.get("ranges") or {}) if k in cls.params]
    heat = _heatmap(results, varied, objective) if len(varied) >= 2 else None
    best = results[0] if results and math.isfinite(results[0]["score"]) else None
    # Robustness: how many neighbours of the best are also good?
    stability = None
    if best and len(results) > 4:
        finite = [r["score"] for r in results if math.isfinite(r["score"])]
        if finite:
            stability = round(float(np.mean(np.array(finite) >= np.percentile(finite, 75))) * 100, 1)
    return _clean({
        "objective": objective, "objective_label": OBJECTIVES.get(objective, objective),
        "n_combos": len(combos), "varied": varied, "best": best, "results": results[:500],
        "heatmap": heat, "warnings": warnings, "strategy": cls.name,
        "score_distribution": [r["score"] for r in results if math.isfinite(r["score"])],
        "stability_pct": stability,
    })


def _heatmap(results, varied, objective):
    px, py = varied[0], varied[1]
    rows = [{px: r["params"][px], py: r["params"][py], "v": r["metrics"].get(objective)}
            for r in results if r.get("metrics") and r["metrics"].get(objective) is not None]
    if not rows:
        return None
    df = pd.DataFrame(rows)
    piv = df.pivot_table(index=py, columns=px, values="v", aggfunc="max")
    return {"x": px, "y": py, "xs": [float(v) for v in piv.columns], "ys": [float(v) for v in piv.index],
            "z": [[None if pd.isna(v) else round(float(v), 4) for v in row] for row in piv.to_numpy()]}


# --------------------------------------------------------------------------- #
# Walk-forward analysis
# --------------------------------------------------------------------------- #
def walk_forward(req: dict, progress: Callable | None = None) -> dict:
    opt = req.get("optimize") or {}
    wf = req.get("walk_forward") or {}
    objective = opt.get("objective", "sharpe")
    min_trades = int(opt.get("min_trades", 1))
    n_splits = max(2, int(wf.get("splits", 5)))
    train_pct = min(max(float(wf.get("train_pct", 70)) / 100, 0.3), 0.9)
    anchored = bool(wf.get("anchored", False))
    market, spec, cls, frames, cfg, warnings = _prepare(req)
    base = coerce_params(cls, spec.get("params"))
    combos = build_grid(cls, opt.get("ranges") or {}, opt.get("method", "grid"), int(opt.get("n_iter", 60)))
    combos = [{**base, **coerce_params(cls, c)} for c in combos]

    index = frames[next(iter(frames))].index
    for f in frames.values():
        index = index.union(f.index)
    n = len(index)
    # Rolling windows: each fold = train + test, test windows tile the back part of the data.
    test_len = int(n * (1 - train_pct) / (n_splits * (1 - train_pct) + train_pct))
    train_len = int(test_len * train_pct / (1 - train_pct))
    if test_len < 20 or train_len < 50:
        raise ValueError("Not enough data for walk-forward; widen the date range or reduce the number of splits")

    folds, oos_rets = [], []
    total_steps = n_splits * (len(combos) + 1)
    done = [0]

    def sub(lo, hi):
        t0, t1 = index[lo], index[min(hi, n - 1)]
        return {s: f[(f.index >= t0) & (f.index <= t1)] for s, f in frames.items()
                if ((f.index >= t0) & (f.index <= t1)).sum() > 2}

    for k in range(n_splits):
        test_start = train_len + k * test_len
        test_end = min(test_start + test_len, n) - 1
        train_start = 0 if anchored else test_start - train_len
        is_frames = sub(train_start, test_start - 1)

        def prog(i, tot):
            if progress:
                progress(done[0] + i, total_steps)
        res = evaluate_many(is_frames, spec, cls, cfg, combos, prog)
        done[0] += len(combos)
        for r in res:
            r["score"] = _score(r.get("metrics"), objective, min_trades)
        res.sort(key=lambda r: r["score"], reverse=True)
        best = res[0]
        # OOS run: warm indicators on the training window, measure only the test window.
        full = Backtester(sub(train_start, test_end), cls, best["params"], cfg).run()
        eq = full["equity"]
        oos_eq = eq[eq.index >= index[test_start]]
        r_oos = oos_eq.pct_change().dropna()
        if len(oos_eq):
            first_ret = oos_eq.iloc[0] / eq[eq.index < index[test_start]].iloc[-1] - 1 \
                if (eq.index < index[test_start]).any() else 0.0
            r_oos = pd.concat([pd.Series([first_ret], index=[oos_eq.index[0]]), r_oos])
        oos_rets.append(r_oos)
        oos_trades = [t for t in full["trades"] if pd.Timestamp(t["exit_time"]) >= index[test_start]]
        oos_curve = (1 + r_oos).cumprod() * cfg.initial_capital
        oos_m = compute_metrics(oos_curve, oos_trades, cfg.periods_per_year, cfg.risk_free_rate) \
            if len(oos_curve) > 2 else {}
        done[0] += 1
        if progress:
            progress(done[0], total_steps)
        folds.append({
            "fold": k + 1,
            "train_start": index[train_start].isoformat(), "train_end": index[test_start - 1].isoformat(),
            "test_start": index[test_start].isoformat(), "test_end": index[test_end].isoformat(),
            "best_params": best["params"],
            "is_score": best["score"] if math.isfinite(best["score"]) else None,
            "is_metrics": best.get("metrics"),
            "oos_metrics": {k2: oos_m.get(k2) for k2 in KEEP} if oos_m else {},
            "oos_score": oos_m.get(objective) if oos_m else None,
        })

    stitched = pd.concat(oos_rets).sort_index()
    stitched = stitched[~stitched.index.duplicated()]
    curve = (1 + stitched).cumprod() * cfg.initial_capital
    curve = pd.concat([pd.Series([cfg.initial_capital], index=[curve.index[0] - pd.Timedelta(seconds=1)]), curve])
    overall = compute_metrics(curve, [], cfg.periods_per_year, cfg.risk_free_rate)
    overall.pop("_drawdowns", None)
    is_scores = [f["is_score"] for f in folds if f["is_score"] is not None]
    oos_scores = [f["oos_score"] for f in folds if f["oos_score"] is not None]
    # Walk-forward efficiency: how much of the in-sample edge survived out of sample.
    # Only meaningful when the optimiser actually found an in-sample edge (mean IS score > 0).
    efficiency = None
    if is_scores and oos_scores and np.mean(is_scores) > 0:
        efficiency = round(float(np.mean(oos_scores) / np.mean(is_scores)) * 100, 1)
    bm_name, bm = load_benchmark(req, frames)
    bench = None
    if bm is not None:
        b = bm.reindex(curve.index, method="ffill").bfill()
        if b.notna().all() and b.iloc[0] > 0:
            bench = _arr(b / b.iloc[0] * cfg.initial_capital, 2)
    return _clean({
        "objective": objective, "objective_label": OBJECTIVES.get(objective, objective),
        "folds": folds, "overall": overall, "efficiency_pct": efficiency,
        "series": {"t": _ts(curve.index), "equity": _arr(curve, 2), "benchmark": bench,
                   "drawdown": _arr((curve / curve.cummax() - 1) * 100, 3)},
        "benchmark_name": bm_name, "n_combos": len(combos), "warnings": warnings, "strategy": cls.name,
        "anchored": anchored,
    })
