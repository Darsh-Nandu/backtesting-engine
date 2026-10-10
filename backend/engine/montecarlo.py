"""Monte Carlo robustness analysis."""
from __future__ import annotations

import numpy as np
import pandas as pd


def _max_dd(paths: np.ndarray) -> np.ndarray:
    peak = np.maximum.accumulate(paths, axis=1)
    return ((paths / peak) - 1).min(axis=1) * 100


def block_bootstrap(equity: pd.Series, n_sims: int = 500, block: int = 20, seed: int = 7) -> dict:
    """Stationary-ish block bootstrap of bar returns (keeps volatility clustering)."""
    rets = equity.pct_change().dropna().to_numpy()
    n = len(rets)
    if n < 10:
        return {}
    rng = np.random.default_rng(seed)
    block = max(1, min(block, n // 4))
    n_blocks = int(np.ceil(n / block))
    starts = rng.integers(0, n - block + 1, size=(n_sims, n_blocks))
    idx = (starts[:, :, None] + np.arange(block)[None, None, :]).reshape(n_sims, -1)[:, :n]
    sim = rets[idx]
    init = float(equity.iloc[0])
    paths = init * np.cumprod(1 + sim, axis=1)
    paths = np.hstack([np.full((n_sims, 1), init), paths])
    return _summarise(paths, init, equity.index, float(equity.iloc[-1]))


def trade_bootstrap(trades: list[dict], equity: pd.Series, n_sims: int = 1000, seed: int = 11) -> dict:
    """Resample the sequence of trades (with replacement) as % impact on equity."""
    if len(trades) < 5:
        return {}
    eq = equity.to_numpy()
    r = np.array([t["pnl"] / max(eq[max(t["entry_bar"] - 1, 0)], 1e-9) for t in trades])
    rng = np.random.default_rng(seed)
    sim = rng.choice(r, size=(n_sims, len(r)), replace=True)
    init = float(equity.iloc[0])
    paths = init * np.cumprod(1 + sim, axis=1)
    paths = np.hstack([np.full((n_sims, 1), init), paths])
    return _summarise(paths, init, None, init * float(np.prod(1 + r)))


def _summarise(paths: np.ndarray, init: float, index, actual_final: float) -> dict:
    finals = paths[:, -1]
    dds = _max_dd(paths)
    pct = [5, 25, 50, 75, 95]
    bands = np.percentile(paths, pct, axis=0)
    # Thin the fan chart to <= 400 points.
    step = max(1, paths.shape[1] // 400)
    sel = np.arange(0, paths.shape[1], step)
    if sel[-1] != paths.shape[1] - 1:
        sel = np.r_[sel, paths.shape[1] - 1]
    if index is not None:
        times = [int(pd.Timestamp(index[min(k, len(index) - 1)]).timestamp()) for k in sel]
    else:
        times = sel.tolist()
    sample = paths[np.linspace(0, len(paths) - 1, min(30, len(paths))).astype(int)][:, sel]
    hist_counts, hist_edges = np.histogram((finals / init - 1) * 100, bins=40)
    dd_counts, dd_edges = np.histogram(dds, bins=30)
    return {
        "n_sims": int(paths.shape[0]),
        "x": times, "time_axis": index is not None,
        "bands": {f"p{p}": np.round(bands[k][sel], 2).tolist() for k, p in enumerate(pct)},
        "sample_paths": np.round(sample, 2).tolist(),
        "final_return_pct": {f"p{p}": round(float(np.percentile(finals / init - 1, p) * 100), 2) for p in pct},
        "max_dd_pct": {f"p{p}": round(float(np.percentile(dds, 100 - p)), 2) for p in pct},
        "prob_loss_pct": round(float((finals < init).mean() * 100), 2),
        "prob_beat_actual_pct": round(float((finals >= actual_final).mean() * 100), 2),
        "return_hist": {"counts": hist_counts.tolist(), "edges": np.round(hist_edges, 2).tolist()},
        "dd_hist": {"counts": dd_counts.tolist(), "edges": np.round(dd_edges, 2).tolist()},
    }
