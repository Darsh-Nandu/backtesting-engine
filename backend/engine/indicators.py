"""Technical indicators.

Every function is *causal*: the value at index ``i`` only depends on data at
indices ``<= i``. That guarantees indicators pre-computed over the full array
never leak future information into a backtest.

All functions accept array-likes and return ``numpy.ndarray`` (or a tuple of
them) with the same length as the input, padded with ``NaN`` during warm-up.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

__all__ = [
    "sma", "ema", "wma", "hma", "rsi", "macd", "bollinger", "atr", "stochastic",
    "adx", "supertrend", "donchian", "keltner", "vwap", "obv", "roc", "momentum",
    "cci", "williams_r", "zscore", "stddev", "highest", "lowest", "crossover",
    "crossunder", "true_range",
]


def _s(x) -> pd.Series:
    return pd.Series(np.asarray(x, dtype=float))


def sma(x, n: int = 20) -> np.ndarray:
    return _s(x).rolling(int(n), min_periods=int(n)).mean().to_numpy()


def ema(x, n: int = 20) -> np.ndarray:
    s = _s(x)
    out = s.ewm(span=int(n), adjust=False, min_periods=int(n)).mean()
    return out.to_numpy()


def wma(x, n: int = 20) -> np.ndarray:
    n = int(n)
    w = np.arange(1, n + 1, dtype=float)
    return _s(x).rolling(n, min_periods=n).apply(lambda a: np.dot(a, w) / w.sum(), raw=True).to_numpy()


def hma(x, n: int = 20) -> np.ndarray:
    n = int(n)
    half, root = max(n // 2, 1), max(int(np.sqrt(n)), 1)
    raw = 2 * wma(x, half) - wma(x, n)
    return wma(np.nan_to_num(raw, nan=np.nan), root)


def stddev(x, n: int = 20) -> np.ndarray:
    return _s(x).rolling(int(n), min_periods=int(n)).std(ddof=0).to_numpy()


def zscore(x, n: int = 20) -> np.ndarray:
    m, sd = sma(x, n), stddev(x, n)
    with np.errstate(divide="ignore", invalid="ignore"):
        return (np.asarray(x, float) - m) / sd


def highest(x, n: int = 20) -> np.ndarray:
    return _s(x).rolling(int(n), min_periods=int(n)).max().to_numpy()


def lowest(x, n: int = 20) -> np.ndarray:
    return _s(x).rolling(int(n), min_periods=int(n)).min().to_numpy()


def rsi(x, n: int = 14) -> np.ndarray:
    s = _s(x)
    d = s.diff()
    up = d.clip(lower=0).ewm(alpha=1 / int(n), adjust=False, min_periods=int(n)).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / int(n), adjust=False, min_periods=int(n)).mean()
    rs = up / dn.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    out[(dn == 0) & up.notna()] = 100.0
    return out.to_numpy()


def macd(x, fast: int = 12, slow: int = 26, signal: int = 9):
    line = ema(x, fast) - ema(x, slow)
    sig = _s(line).ewm(span=int(signal), adjust=False, min_periods=int(signal)).mean().to_numpy()
    return line, sig, line - sig


def bollinger(x, n: int = 20, k: float = 2.0):
    mid, sd = sma(x, n), stddev(x, n)
    return mid + k * sd, mid, mid - k * sd


def true_range(high, low, close) -> np.ndarray:
    h, l, c = (np.asarray(a, float) for a in (high, low, close))
    pc = np.r_[np.nan, c[:-1]]
    tr = np.fmax(np.fmax(h - l, np.abs(h - pc)), np.abs(l - pc))  # fmax skips NaN quietly
    return tr


def atr(high, low, close, n: int = 14) -> np.ndarray:
    tr = true_range(high, low, close)
    return _s(tr).ewm(alpha=1 / int(n), adjust=False, min_periods=int(n)).mean().to_numpy()


def stochastic(high, low, close, k: int = 14, d: int = 3):
    hh, ll = highest(high, k), lowest(low, k)
    with np.errstate(divide="ignore", invalid="ignore"):
        pk = 100 * (np.asarray(close, float) - ll) / (hh - ll)
    return pk, sma(pk, d)


def adx(high, low, close, n: int = 14):
    h, l = np.asarray(high, float), np.asarray(low, float)
    up = np.r_[np.nan, np.diff(h)]
    dn = np.r_[np.nan, -np.diff(l)]
    plus_dm = np.where((up > dn) & (up > 0), up, 0.0)
    minus_dm = np.where((dn > up) & (dn > 0), dn, 0.0)
    a = atr(high, low, close, n)
    sm = lambda v: _s(v).ewm(alpha=1 / int(n), adjust=False, min_periods=int(n)).mean().to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        pdi = 100 * sm(plus_dm) / a
        mdi = 100 * sm(minus_dm) / a
        dx = 100 * np.abs(pdi - mdi) / (pdi + mdi)
    return sm(np.nan_to_num(dx)), pdi, mdi


def supertrend(high, low, close, n: int = 10, mult: float = 3.0):
    """Returns (line, direction) where direction is +1 (up-trend) / -1."""
    h, l, c = (np.asarray(a, float) for a in (high, low, close))
    a = atr(h, l, c, n)
    hl2 = (h + l) / 2
    ub, lb = hl2 + mult * a, hl2 - mult * a
    fub, flb = ub.copy(), lb.copy()
    line = np.full(len(c), np.nan)
    direction = np.zeros(len(c))
    for i in range(1, len(c)):
        if np.isnan(a[i]):
            continue
        fub[i] = ub[i] if (np.isnan(fub[i - 1]) or ub[i] < fub[i - 1] or c[i - 1] > fub[i - 1]) else fub[i - 1]
        flb[i] = lb[i] if (np.isnan(flb[i - 1]) or lb[i] > flb[i - 1] or c[i - 1] < flb[i - 1]) else flb[i - 1]
        prev = direction[i - 1] or 1
        if prev == 1 and c[i] < flb[i]:
            direction[i] = -1
        elif prev == -1 and c[i] > fub[i]:
            direction[i] = 1
        else:
            direction[i] = prev
        line[i] = flb[i] if direction[i] == 1 else fub[i]
    return line, direction


def donchian(high, low, n: int = 20):
    up, dn = highest(high, n), lowest(low, n)
    return up, (up + dn) / 2, dn


def keltner(high, low, close, n: int = 20, mult: float = 2.0):
    mid = ema(close, n)
    a = atr(high, low, close, n)
    return mid + mult * a, mid, mid - mult * a


def vwap(high, low, close, volume, n: int = 20) -> np.ndarray:
    """Rolling VWAP over ``n`` bars (session VWAP needs intraday session info)."""
    tp = (np.asarray(high, float) + np.asarray(low, float) + np.asarray(close, float)) / 3
    v = np.asarray(volume, float)
    num = _s(tp * v).rolling(int(n), min_periods=int(n)).sum()
    den = _s(v).rolling(int(n), min_periods=int(n)).sum().replace(0, np.nan)
    return (num / den).to_numpy()


def obv(close, volume) -> np.ndarray:
    c, v = np.asarray(close, float), np.asarray(volume, float)
    sign = np.sign(np.r_[0, np.diff(c)])
    return np.cumsum(sign * v)


def roc(x, n: int = 10) -> np.ndarray:
    s = _s(x)
    return (100 * (s / s.shift(int(n)) - 1)).to_numpy()


def momentum(x, n: int = 10) -> np.ndarray:
    s = _s(x)
    return (s - s.shift(int(n))).to_numpy()


def cci(high, low, close, n: int = 20) -> np.ndarray:
    tp = _s((np.asarray(high, float) + np.asarray(low, float) + np.asarray(close, float)) / 3)
    m = tp.rolling(int(n), min_periods=int(n)).mean()
    md = tp.rolling(int(n), min_periods=int(n)).apply(lambda a: np.mean(np.abs(a - a.mean())), raw=True)
    return ((tp - m) / (0.015 * md)).to_numpy()


def williams_r(high, low, close, n: int = 14) -> np.ndarray:
    hh, ll = highest(high, n), lowest(low, n)
    with np.errstate(divide="ignore", invalid="ignore"):
        return -100 * (hh - np.asarray(close, float)) / (hh - ll)


def crossover(a, b) -> bool:
    """True if series ``a`` crossed above ``b`` on the latest bar.

    Works with engine series views, numpy arrays (uses the last two values) or
    scalars for ``b``.
    """
    a0, a1 = _last2(a)
    b0, b1 = _last2(b)
    return bool(a0 <= b0 and a1 > b1)


def crossunder(a, b) -> bool:
    a0, a1 = _last2(a)
    b0, b1 = _last2(b)
    return bool(a0 >= b0 and a1 < b1)


def _last2(x):
    if np.isscalar(x):
        return float(x), float(x)
    try:
        prev, cur = x[-2], x[-1]
    except (IndexError, KeyError):
        return np.nan, np.nan
    return float(prev), float(cur)
