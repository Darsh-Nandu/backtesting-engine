import numpy as np
import pandas as pd

from backend.api import store
from backend.engine.charting import _epoch, _resample_session


def _minute_bars(days=2, tz="America/New_York"):
    frames = []
    for d in range(days):
        idx = pd.date_range(f"2026-03-0{2 + d} 09:30", periods=390, freq="1min", tz=tz)
        frames.append(pd.DataFrame({"open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 10.0}, index=idx))
    df = pd.concat(frames)
    df["close"] = np.arange(len(df), dtype=float)
    return df


def test_4h_bars_align_to_each_session():
    df = _minute_bars()
    out = _resample_session(df.resample("60min", origin="start").agg({"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}).dropna(), 240)
    # Each 6.5 h session splits into a 4 h block (09:30) and a shorter one (13:30).
    assert [t.strftime("%d %H:%M") for t in out.index] == ["02 09:30", "02 13:30", "03 09:30", "03 13:30"]
    assert out["volume"].iloc[0] == 4 * 60 * 10


def test_daily_epoch_is_the_exchange_date():
    idx = pd.DatetimeIndex(["2026-10-09 00:00"], tz="Asia/Kolkata")  # midnight IST = previous day 18:30 UTC
    t = _epoch(pd.DataFrame({"close": [1.0]}, index=idx), "1D")
    assert pd.Timestamp(t[0], unit="s").strftime("%Y-%m-%d %H:%M") == "2026-10-09 00:00"


def test_intraday_epoch_is_utc():
    idx = pd.DatetimeIndex(["2026-10-09 09:30"], tz="America/New_York")
    assert _epoch(pd.DataFrame({"close": [1.0]}, index=idx), "1m")[0] == int(pd.Timestamp("2026-10-09 13:30", tz="UTC").timestamp())


def test_layouts_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "LAYOUT_DIR", tmp_path)
    meta = store.save_layout("My NFLX setup", {"symbol": "NFLX", "doc": {"indicators": [{"type": "rsi"}]}})
    assert meta["id"] == "my_nflx_setup" and "state" not in meta
    assert store.list_layouts()[0]["symbol"] == "NFLX"
    assert store.get_layout("my_nflx_setup")["state"]["doc"]["indicators"][0]["type"] == "rsi"
    assert store.delete_layout("my_nflx_setup") and store.list_layouts() == []


def test_csv_upload_charts_and_resamples(tmp_path, monkeypatch):
    from backend.engine import charting, data as datamod
    monkeypatch.setattr(datamod, "UPLOAD_DIR", tmp_path)
    idx = pd.date_range("2026-01-05 09:15", periods=375 * 3, freq="1min")
    idx = idx[idx.indexer_between_time("09:15", "15:29")]
    rows = "\n".join(f"{t:%Y-%m-%d %H:%M},{100 + i * 0.01:.2f},{100.5 + i * 0.01:.2f},{99.5 + i * 0.01:.2f},{100.2 + i * 0.01:.2f},{1000}" for i, t in enumerate(idx))
    datamod.save_upload("my ticks.csv", ("Datetime,Open,High,Low,Close,Volume\n" + rows).encode())
    native = charting.bars("csv:MY_TICKS", "1m")
    assert native["interval"] == "1m" and native["native"] == "1m" and native["symbol"] == "CSV:MY_TICKS"
    hourly = charting.bars("CSV:my_ticks", "1h")
    assert hourly["interval"] == "1h" and len(hourly["t"]) < len(native["t"]) / 50
    assert hourly["v"][0] == 60 * 1000 and hourly["h"][0] >= hourly["c"][0]
    daily = charting.bars("csv:MY_TICKS", "1D")
    assert daily["interval"] == "1D" and len(daily["t"]) == len({t.date() for t in idx})
    # Asking for something finer than the file returns the file's own interval.
    d = charting.bars("csv:MY_TICKS", "1D")
    assert charting.bars("csv:MY_TICKS", "1m")["interval"] == "1m" and d["native"] == "1m"


def test_native_interval_detection():
    from backend.engine.charting import _native_interval
    assert _native_interval(pd.date_range("2020-01-01", periods=50, freq="B")) == "1D"
    assert _native_interval(pd.date_range("2020-01-01", periods=50, freq="W")) == "1W"
    assert _native_interval(pd.date_range("2020-01-01", periods=50, freq="15min")) == "15m"
    assert _native_interval(pd.date_range("2020-01-01", periods=50, freq="MS")) == "1M"


def test_csv_date_order_detection():
    from backend.engine.data import normalize_ohlcv
    days = pd.date_range("2024-01-01", periods=60, freq="D")
    close = np.arange(60) + 100.0
    for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%m/%d/%Y", "%Y-%m-%d", "%d.%m.%Y"):
        out = normalize_ohlcv(pd.DataFrame({"Date": days.strftime(fmt), "Close": close}))
        assert list(out.index) == list(days), fmt
        assert out["close"].is_monotonic_increasing, fmt
    # Only ambiguous dates (all days <= 12): the order that sorts cleanly wins.
    short = pd.date_range("2024-01-01", periods=12, freq="D")
    out = normalize_ohlcv(pd.DataFrame({"Date": short.strftime("%d-%m-%Y"), "Close": np.arange(12) + 1.0}))
    assert list(out.index) == list(short)


def test_csv_epoch_timestamps():
    from backend.engine.data import normalize_ohlcv
    t = pd.date_range("2026-03-02 14:30", periods=50, freq="5min")
    secs = (t.as_unit("s").asi8).astype("int64")
    for scale, label in ((1, "s"), (1000, "ms")):
        out = normalize_ohlcv(pd.DataFrame({"time": secs * scale, "close": np.arange(50) + 1.0}))
        assert out.index[0] == t[0] and out.index[-1] == t[-1], label


def test_market_symbols_are_refused():
    import pytest
    from backend.engine import charting
    from backend.engine.data import DataError
    with pytest.raises(DataError, match="CSV"):
        charting.bars("NFLX", "1D")
