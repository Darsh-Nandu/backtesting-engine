"""Chart data for the Analyze workspace, which works on uploaded CSV datasets only.

A dataset is addressed as ``CSV:<NAME>``. Bars come back at the file's own interval or resampled
to any coarser one (intraday blocks aligned to each session's first bar).
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .data import DataError, load_upload

DAILY = {"1D", "1W", "1M"}
SECONDS = {"1m": 60, "2m": 120, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1D": 86400, "1W": 604800, "1M": 2592000}
CSV_PREFIX = "CSV:"


def _resample_session(df: pd.DataFrame, minutes: int) -> pd.DataFrame:
    """Bucket each session into blocks of `minutes` from its first bar (exchange-aligned, e.g. 09:15, 10:15 ...)."""
    ns = df.index.tz_localize(None).as_unit("ns").asi8 if df.index.tz is not None else df.index.as_unit("ns").asi8
    day = ns // 86_400_000_000_000
    first = pd.Series(ns).groupby(day).transform("min").to_numpy()
    block = (ns - first) // (minutes * 60_000_000_000)
    key = day * 10_000 + block
    g = df.reset_index(drop=True).groupby(key, sort=True)
    out = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                        "close": g["close"].last(), "volume": g["volume"].sum()})
    starts = pd.Series(np.arange(len(df))).groupby(key, sort=True).min().to_numpy()
    out.index = df.index[starts]
    return out


def _epoch(df: pd.DataFrame, interval: str) -> np.ndarray:
    idx = df.index
    if interval in DAILY:
        # A daily bar belongs to a calendar date, not an instant: midnight UTC of the exchange date.
        d = idx.tz_localize(None) if idx.tz is not None else idx
        return d.normalize().as_unit("s").asi8
    if idx.tz is None:
        idx = idx.tz_localize("UTC")
    return idx.tz_convert("UTC").as_unit("s").asi8


def _native_interval(idx: pd.DatetimeIndex) -> str:
    """The chart interval closest to (and not finer than) the typical spacing of the data."""
    if len(idx) < 3:
        return "1D"
    step = float(np.median(np.diff(idx.as_unit("s").asi8)))
    if step >= 20 * 86400:
        return "1M"
    if step >= 4 * 86400:
        return "1W"
    if step >= 0.9 * 86400 or (idx.normalize() == idx).all():
        return "1D"
    for k in ("4h", "1h", "30m", "15m", "5m", "2m", "1m"):
        if step >= SECONDS[k] * 0.95:
            return k
    return "1m"


def _resample(df: pd.DataFrame, interval: str) -> pd.DataFrame:
    if interval not in DAILY:
        return _resample_session(df, SECONDS[interval] // 60)
    agg = {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    rule = {"1D": "D", "1W": "W-MON", "1M": "MS"}[interval]
    kw = {"label": "left", "closed": "left"} if interval == "1W" else {}
    return df.resample(rule, **kw).agg(agg).dropna(subset=["close"])


def csv_bars(name: str, interval: str = "1D") -> dict:
    """An uploaded CSV as chart bars, resampled to `interval` when that is coarser than the file."""
    df = load_upload(name)
    native = _native_interval(df.index)
    actual = interval if SECONDS.get(interval, 0) > SECONDS[native] else native
    if actual != native:
        df = _resample(df, actual)
    t = _epoch(df, actual)
    r = lambda s, nd=6: [None if not math.isfinite(v) else round(float(v), nd) for v in s]
    return {"symbol": CSV_PREFIX + name.upper(), "interval": actual, "native": native, "source": "csv", "timezone": "UTC",
            "prepost": False, "adjusted": False, "t": t.tolist(), "o": r(df["open"]), "h": r(df["high"]), "l": r(df["low"]),
            "c": r(df["close"]), "v": r(df["volume"], 0)}


def bars(symbol: str, interval: str = "1D") -> dict:
    symbol = (symbol or "").strip()
    if not symbol.upper().startswith(CSV_PREFIX):
        raise DataError("Analyze works on your uploaded CSV datasets. Upload a CSV and open it as CSV:<NAME>.")
    if interval not in SECONDS:
        raise DataError(f"Unsupported interval '{interval}'")
    return csv_bars(symbol[len(CSV_PREFIX):], interval)
