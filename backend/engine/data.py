"""Market-data providers.

* ``yahoo``     - Yahoo Finance (NSE, BSE, NASDAQ, NYSE, LSE, crypto, FX, ...)
                  with an on-disk cache so repeated runs are instant.
* ``csv``       - user uploaded OHLCV files (flexible column detection).
* ``synthetic`` - deterministic regime-switching GBM for offline experiments.

Every loader returns a DataFrame indexed by a tz-naive ``DatetimeIndex`` with
columns ``open, high, low, close, volume`` (floats), sorted and de-duplicated.
"""
from __future__ import annotations

import hashlib
import io
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout
from pathlib import Path

import numpy as np
import pandas as pd

from .markets import get_market

ROOT = Path(__file__).resolve().parents[2]
# Everything the app writes lives under one folder; QF_DATA_DIR points it elsewhere (used by the e2e tests).
DATA_ROOT = Path(os.environ.get("QF_DATA_DIR") or ROOT / "data_store")
CACHE_DIR = Path(os.environ.get("QF_CACHE_DIR") or DATA_ROOT / "cache")
UPLOAD_DIR = DATA_ROOT / "uploads"
for _d in (CACHE_DIR, UPLOAD_DIR):
    _d.mkdir(parents=True, exist_ok=True)

COLUMNS = ["open", "high", "low", "close", "volume"]
INTERVALS = ["1m", "5m", "15m", "30m", "60m", "1h", "1d", "1wk", "1mo"]
# Yahoo's look-back limits for intraday data (calendar days).
INTRADAY_LIMIT_DAYS = {"1m": 7, "5m": 59, "15m": 59, "30m": 59, "60m": 729, "1h": 729}
CACHE_TTL_SECONDS = 6 * 3600
# Hard ceiling for one symbol's download, including retries. When Yahoo rejects the session it can
# otherwise stall for minutes inside yfinance (30 s crumb timeouts, retried).
DOWNLOAD_BUDGET_SECONDS = 25.0
_YAHOO_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="yahoo")


class DataError(Exception):
    pass


# --------------------------------------------------------------------------- #
# Normalisation
# --------------------------------------------------------------------------- #
_ALIASES = {
    "open": ["open", "o", "open price", "opening price"],
    "high": ["high", "h", "high price"],
    "low": ["low", "l", "low price"],
    "close": ["close", "c", "close price", "closing price", "last", "ltp", "price"],
    "adj close": ["adj close", "adj_close", "adjclose", "adjusted close", "adjusted_close"],
    "volume": ["volume", "vol", "v", "shares traded", "total traded quantity", "qty"],
    "date": ["date", "datetime", "timestamp", "time", "date_time", "dt", "index"],
}


_DMY = re.compile(r"^\s*(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2,4})")


def _parse_dates(col: pd.Series) -> pd.Series:
    """Parse a date column, working out day-first (DD-MM-YYYY, common in India/Europe) vs month-first.

    A part above 12 settles it; if every date is ambiguous, the order that gives a sorted series wins.
    """
    num = pd.to_numeric(col, errors="coerce")
    if num.notna().mean() > 0.9 and num.median() > 1e8:
        # Unix timestamps: seconds, milliseconds or microseconds since 1970.
        med = num.median()
        unit = "us" if med > 1e14 else "ms" if med > 1e11 else "s"
        return pd.to_datetime(num, unit=unit, errors="coerce")
    text = col.astype(str)
    parts = text.str.extract(_DMY)
    if parts.notna().all(axis=1).mean() < 0.5:  # ISO, epoch or textual dates: no ambiguity
        return pd.to_datetime(col, errors="coerce", format="mixed")
    a, b = pd.to_numeric(parts[0], errors="coerce"), pd.to_numeric(parts[1], errors="coerce")
    if (a > 12).any() and not (b > 12).any():
        dayfirst = True
    elif (b > 12).any() and not (a > 12).any():
        dayfirst = False
    else:
        tries = {df: pd.to_datetime(col, errors="coerce", format="mixed", dayfirst=df) for df in (False, True)}
        # Most rows in time order wins; on a tie, the tighter (more regular) spacing wins.
        score = {df: ((v.diff().dt.total_seconds() > 0).sum() - v.isna().sum() * 10, -v.diff().dt.total_seconds().abs().median())
                 for df, v in tries.items()}
        return tries[score[True] > score[False]]
    return pd.to_datetime(col, errors="coerce", format="mixed", dayfirst=dayfirst)


def normalize_ohlcv(df: pd.DataFrame, use_adjusted: bool = False) -> pd.DataFrame:
    if df is None or df.empty:
        raise DataError("No rows in dataset")
    df = df.copy()
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [c[0] for c in df.columns]
    lookup = {re.sub(r"\s+", " ", str(c).strip().lower()): c for c in df.columns}

    def find(key):
        for alias in _ALIASES[key]:
            if alias in lookup:
                return lookup[alias]
        return None

    if not isinstance(df.index, pd.DatetimeIndex):
        dcol = find("date")
        if dcol is None:
            dcol = df.columns[0]
        idx = _parse_dates(df[dcol])
        if idx.isna().mean() > 0.5:  # maybe epoch seconds / ms
            num = pd.to_numeric(df[dcol], errors="coerce")
            unit = "ms" if num.median() > 1e11 else "s"
            idx = pd.to_datetime(num, unit=unit, errors="coerce")
        df.index = idx
    out = pd.DataFrame(index=df.index)
    close_col = find("close")
    adj_col = find("adj close")
    if close_col is None and adj_col is None:
        raise DataError(f"Could not find a close/price column in {list(df.columns)}")
    raw_close = pd.to_numeric(df[close_col if close_col is not None else adj_col], errors="coerce")
    out["close"] = raw_close
    for k in ("open", "high", "low"):
        col = find(k)
        out[k] = pd.to_numeric(df[col], errors="coerce") if col is not None else raw_close
    if use_adjusted and adj_col is not None and close_col is not None:
        # Scale the whole candle by the adjustment factor; carry the factor across
        # bars where the provider has not published an adjusted close yet.
        factor = (pd.to_numeric(df[adj_col], errors="coerce") / raw_close).replace([np.inf, -np.inf], np.nan)
        factor = factor.ffill().bfill().fillna(1.0)
        for k in ("open", "high", "low", "close"):
            out[k] = out[k] * factor
    vcol = find("volume")
    out["volume"] = pd.to_numeric(df[vcol], errors="coerce").fillna(0) if vcol is not None else 0.0

    out = out[~out.index.isna()]
    if getattr(out.index, "tz", None) is not None:
        out.index = out.index.tz_localize(None)
    out = out[~out.index.duplicated(keep="last")].sort_index()
    out = out.dropna(subset=["close"])
    for k in ("open", "high", "low"):
        out[k] = out[k].fillna(out["close"])
    # Repair inconsistent candles (common in CSV exports).
    out["high"] = out[["open", "high", "low", "close"]].max(axis=1)
    out["low"] = out[["open", "high", "low", "close"]].min(axis=1)
    out = out[out["close"] > 0]
    out.index.name = "date"
    if len(out) < 2:
        raise DataError("Dataset has fewer than 2 valid bars")
    return out[COLUMNS].astype(float)


# --------------------------------------------------------------------------- #
# Yahoo Finance
# --------------------------------------------------------------------------- #
def _cache_path(symbol: str, interval: str, adjusted: bool) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.=^-]", "_", symbol)
    return CACHE_DIR / f"{safe}__{interval}__{'adj' if adjusted else 'raw'}.csv"


def load_yahoo(symbol: str, start: str | None, end: str | None, interval: str = "1d",
               adjusted: bool = True, refresh: bool = False) -> pd.DataFrame:
    if interval not in INTERVALS:
        raise DataError(f"Unsupported interval {interval}")
    path = _cache_path(symbol, interval, adjusted)
    fresh = path.exists() and (time.time() - path.stat().st_mtime) < CACHE_TTL_SECONDS
    df = None
    if path.exists() and (fresh or not refresh):
        df = pd.read_csv(path, index_col=0, parse_dates=True)
        # Cache covers the request?
        if not df.empty and start and pd.Timestamp(start) < df.index[0] - pd.Timedelta(days=7):
            df = None
        elif not df.empty and not fresh and end is None:
            df = None  # stale cache and caller wants the latest bars
    stale = False
    if df is None or refresh:
        try:
            df = _download_yahoo(symbol, interval, adjusted)
            df.to_csv(path)
        except DataError:
            if not path.exists():
                raise
            # Yahoo is unreachable or rejecting us right now: keep working from the last good copy.
            df = pd.read_csv(path, index_col=0, parse_dates=True)
            stale = True
    out = _slice(df, start, end)
    if stale:
        out.attrs["stale_until"] = df.index[-1].date().isoformat()
    return out


def _reset_yahoo_session():
    """Drop yfinance's cached cookie/crumb and open a new HTTP session.

    yfinance keeps one session per process; in a long-running server Yahoo
    eventually rejects its cookie and every download comes back empty
    ("possibly delisted"). A fresh session fixes that without a restart.
    """
    try:
        from yfinance import data as yfd
        yd = yfd.YfData()
        with yd._cookie_lock:
            yd._cookie = None
            yd._crumb = None
            yd._session = yfd.new_session()
    except Exception:  # internals changed in a future yfinance: retrying still helps
        pass


def _download_yahoo(symbol: str, interval: str, adjusted: bool) -> pd.DataFrame:
    try:
        import yfinance as yf
    except ImportError as e:  # pragma: no cover
        raise DataError("yfinance is not installed") from e
    kwargs = dict(interval=interval, auto_adjust=False, actions=False)
    if interval in INTRADAY_LIMIT_DAYS:
        kwargs["period"] = f"{INTRADAY_LIMIT_DAYS[interval]}d"
    else:
        kwargs["period"] = "max"
    last_err = None
    deadline = time.monotonic() + DOWNLOAD_BUDGET_SECONDS
    for attempt in range(3):
        if attempt:
            _reset_yahoo_session()
            time.sleep(0.5 * attempt)
        remaining = deadline - time.monotonic()
        if remaining <= 1:
            break
        try:
            fut = _YAHOO_POOL.submit(lambda t=min(10.0, remaining): yf.Ticker(symbol).history(timeout=t, **kwargs))
            try:
                raw = fut.result(timeout=remaining)
            except FuturesTimeout:
                last_err = DataError(f"Yahoo Finance did not respond in time for '{symbol}'. "
                                     "It may be rate-limiting this computer; try again in a minute.")
                break
            if raw is not None and len(raw) >= 2:
                return normalize_ohlcv(raw, use_adjusted=adjusted)
            if raw is not None and len(raw) == 1:
                raise DataError(f"Yahoo Finance only returns the latest bar for '{symbol}' (no history available "
                                f"there). Try the same company on another exchange, e.g. the NSE listing.")
            last_err = DataError(f"Yahoo Finance returned no data for '{symbol}'. Check the ticker/market.")
        except DataError:
            raise  # definitive answer from the provider, retrying won't help
        except Exception as e:  # network / rate-limit
            last_err = DataError(f"Download failed for '{symbol}': {e}")
    raise last_err


def _slice(df: pd.DataFrame, start, end) -> pd.DataFrame:
    if start:
        df = df[df.index >= pd.Timestamp(start)]
    if end:
        df = df[df.index <= pd.Timestamp(end) + pd.Timedelta(hours=23, minutes=59)]
    if len(df) < 2:
        raise DataError("Not enough data in the selected date range")
    return df


# --------------------------------------------------------------------------- #
# CSV uploads
# --------------------------------------------------------------------------- #
def save_upload(name: str, content: bytes) -> dict:
    name = re.sub(r"[^A-Za-z0-9_.-]", "_", Path(name).stem).upper() or "UPLOAD"
    try:
        raw = pd.read_csv(io.BytesIO(content), sep=None, engine="python")
    except Exception as e:
        raise DataError(f"Could not parse CSV: {e}") from e
    df = normalize_ohlcv(raw)
    df.to_csv(UPLOAD_DIR / f"{name}.csv")
    return dataset_info(name, df)


def list_uploads() -> list[dict]:
    out = []
    for p in sorted(UPLOAD_DIR.glob("*.csv")):
        try:
            df = pd.read_csv(p, index_col=0, parse_dates=True)
            out.append(dataset_info(p.stem, df))
        except Exception:
            continue
    return out


def delete_upload(name: str) -> bool:
    p = UPLOAD_DIR / f"{Path(name).stem}.csv"
    if p.exists():
        p.unlink()
        return True
    return False


def load_upload(name: str, start=None, end=None) -> pd.DataFrame:
    p = UPLOAD_DIR / f"{Path(name).stem.upper()}.csv"
    if not p.exists():
        p = UPLOAD_DIR / f"{Path(name).stem}.csv"
    if not p.exists():
        raise DataError(f"Uploaded dataset '{name}' not found")
    df = pd.read_csv(p, index_col=0, parse_dates=True)
    return _slice(df[COLUMNS].astype(float), start, end)


def dataset_info(name: str, df: pd.DataFrame) -> dict:
    return {
        "name": name, "rows": int(len(df)),
        "start": df.index[0].isoformat(), "end": df.index[-1].isoformat(),
        "last_close": float(df["close"].iloc[-1]),
    }


# --------------------------------------------------------------------------- #
# Synthetic data
# --------------------------------------------------------------------------- #
def load_synthetic(symbol: str, start=None, end=None, interval: str = "1d") -> pd.DataFrame:
    """Regime-switching geometric Brownian motion, seeded by the symbol name."""
    seed = int(hashlib.md5(symbol.encode()).hexdigest()[:8], 16)
    rng = np.random.default_rng(seed)
    start = pd.Timestamp(start or "2015-01-01")
    end = pd.Timestamp(end or pd.Timestamp.today().normalize())
    freq = {"1d": "B", "1wk": "W-FRI", "1mo": "ME", "1h": "h", "60m": "h"}.get(interval, "B")
    idx = pd.date_range(start, end, freq=freq)
    n = len(idx)
    if n < 2:
        raise DataError("Date range too short")
    regimes = np.array([[0.0007, 0.010], [-0.0006, 0.022], [0.0002, 0.014]])  # bull, bear, chop
    trans = np.array([[0.985, 0.005, 0.010], [0.015, 0.970, 0.015], [0.012, 0.008, 0.980]])
    state, rets = 0, np.empty(n)
    for i in range(n):
        state = rng.choice(3, p=trans[state])
        mu, sig = regimes[state]
        rets[i] = rng.standard_t(5) * sig * np.sqrt(3 / 5) + mu
    close = 100 * np.exp(np.cumsum(rets))
    gap = rng.normal(0, 0.003, n)
    open_ = np.r_[close[0], close[:-1]] * np.exp(gap)
    span = np.abs(rng.normal(0, 0.008, n)) * close
    high = np.maximum(open_, close) + span * rng.random(n)
    low = np.minimum(open_, close) - span * rng.random(n)
    vol = rng.lognormal(13, 0.4, n) * (1 + 5 * np.abs(rets))
    return pd.DataFrame({"open": open_, "high": high, "low": low, "close": close, "volume": vol},
                        index=pd.DatetimeIndex(idx, name="date"))


# --------------------------------------------------------------------------- #
# Front door
# --------------------------------------------------------------------------- #
def load(source: str, market: str, ticker: str, start=None, end=None, interval="1d",
         adjusted=True, refresh=False) -> tuple[str, pd.DataFrame]:
    """Return ``(resolved_symbol, frame)`` for a ticker in a market."""
    source = (source or "yahoo").lower()
    if source == "csv":
        return ticker.upper(), load_upload(ticker, start, end)
    if source == "synthetic":
        return ticker.upper(), load_synthetic(ticker.upper(), start, end, interval)
    sym = get_market(market).to_yahoo(ticker)
    return sym, load_yahoo(sym, start, end, interval, adjusted, refresh)


def search_symbols(query: str, limit: int = 12) -> list[dict]:
    """Ticker autocomplete backed by Yahoo's search endpoint (best effort)."""
    try:
        import yfinance as yf
        res = yf.Search(query, max_results=limit, news_count=0)
        quotes = res.quotes or []
    except Exception:
        return []
    out = []
    for q in quotes:
        out.append({
            "symbol": q.get("symbol"), "name": q.get("shortname") or q.get("longname") or "",
            "exchange": q.get("exchDisp") or q.get("exchange") or "", "type": q.get("quoteType") or "",
        })
    return out
