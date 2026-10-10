"""Performance & risk analytics."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd


def _f(x, nd=4):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(x) or math.isinf(x):
        return None
    return round(x, nd)


def drawdown(equity: pd.Series) -> pd.Series:
    peak = equity.cummax()
    return (equity / peak - 1) * 100


def _dd_durations(dd: pd.Series):
    """Longest drawdown duration in bars and in calendar days, plus the episode list."""
    under = dd < -1e-9
    longest_bars, longest_days, cur_start = 0, 0, None
    episodes = []
    idx = dd.index
    for k, u in enumerate(under.to_numpy()):
        if u and cur_start is None:
            cur_start = k
        elif not u and cur_start is not None:
            seg = dd.iloc[cur_start:k]
            episodes.append((cur_start, k, float(seg.min()), int(seg.values.argmin()) + cur_start))
            cur_start = None
    if cur_start is not None:
        seg = dd.iloc[cur_start:]
        episodes.append((cur_start, None, float(seg.min()), int(seg.values.argmin()) + cur_start))
    out = []
    for s, e, depth, trough in episodes:
        end_k = e if e is not None else len(dd) - 1
        bars = end_k - s
        days = (idx[end_k] - idx[s]).days
        longest_bars, longest_days = max(longest_bars, bars), max(longest_days, days)
        out.append({"start": idx[s], "trough": idx[trough], "end": idx[e] if e is not None else None,
                    "depth_pct": depth, "bars": bars, "days": days, "recovered": e is not None})
    out.sort(key=lambda r: r["depth_pct"])
    return longest_bars, longest_days, out


def compute_metrics(equity: pd.Series, trades: list[dict], ppy: float, rf: float = 0.0,
                    benchmark: pd.Series | None = None, exposure: pd.Series | None = None,
                    fees: float = 0.0) -> dict:
    equity = equity.astype(float)
    rets = equity.pct_change().fillna(0.0)
    n = len(equity)
    start, end = equity.index[0], equity.index[-1]
    years = max((end - start).days / 365.25, 1 / 365.25)
    init, final = float(equity.iloc[0]), float(equity.iloc[-1])
    total_ret = final / init - 1
    cagr = (final / init) ** (1 / years) - 1 if final > 0 else -1.0
    rf_per = (1 + rf) ** (1 / ppy) - 1
    ex = rets - rf_per
    vol = rets.std(ddof=1) * math.sqrt(ppy) if n > 2 else 0.0
    sharpe = ex.mean() / rets.std(ddof=1) * math.sqrt(ppy) if rets.std(ddof=1) > 0 else 0.0
    downside = np.sqrt(np.mean(np.minimum(ex, 0) ** 2))
    sortino = ex.mean() / downside * math.sqrt(ppy) if downside > 0 else 0.0
    dd = drawdown(equity)
    max_dd = float(dd.min())
    calmar = cagr / abs(max_dd / 100) if max_dd < 0 else 0.0
    dd_bars, dd_days, dd_episodes = _dd_durations(dd)
    ulcer = math.sqrt(np.mean(dd.to_numpy() ** 2))
    nz = rets[rets != 0]
    var95 = float(np.percentile(rets, 5)) * 100 if n > 20 else 0.0
    cvar95 = float(rets[rets <= np.percentile(rets, 5)].mean()) * 100 if n > 20 else 0.0
    gains, losses = rets[rets > 0].sum(), -rets[rets < 0].sum()
    omega = gains / losses if losses > 0 else None
    tail = (abs(np.percentile(rets, 95)) / abs(np.percentile(rets, 5))) if n > 20 and np.percentile(rets, 5) != 0 else None

    m = {
        "start": start.isoformat(), "end": end.isoformat(), "bars": n, "years": _f(years, 2),
        "initial_capital": _f(init, 2), "final_equity": _f(final, 2), "net_profit": _f(final - init, 2),
        "total_return_pct": _f(total_ret * 100, 2), "cagr_pct": _f(cagr * 100, 2),
        "volatility_pct": _f(vol * 100, 2), "sharpe": _f(sharpe, 3), "sortino": _f(sortino, 3),
        "calmar": _f(calmar, 3), "max_drawdown_pct": _f(max_dd, 2), "avg_drawdown_pct": _f(dd[dd < 0].mean(), 2),
        "max_dd_duration_bars": dd_bars, "max_dd_duration_days": dd_days, "ulcer_index": _f(ulcer, 3),
        "recovery_factor": _f(total_ret * 100 / abs(max_dd), 3) if max_dd < 0 else None,
        "var_95_pct": _f(var95, 3), "cvar_95_pct": _f(cvar95, 3), "omega": _f(omega, 3), "tail_ratio": _f(tail, 3),
        "skew": _f(nz.skew(), 3) if len(nz) > 3 else None, "kurtosis": _f(nz.kurt(), 3) if len(nz) > 3 else None,
        "best_period_pct": _f(rets.max() * 100, 2), "worst_period_pct": _f(rets.min() * 100, 2),
        "exposure_pct": _f((exposure > 1e-9).mean() * 100, 2) if exposure is not None else None,
        "avg_leverage": _f(exposure[exposure > 1e-9].mean(), 3) if exposure is not None and (exposure > 1e-9).any() else 0,
        "total_fees": _f(fees, 2), "fees_pct_of_capital": _f(fees / init * 100, 3),
    }

    # --- benchmark-relative ------------------------------------------------- #
    if benchmark is not None and len(benchmark.dropna()) > 2:
        b = benchmark.reindex(equity.index).ffill().bfill()
        brets = b.pct_change().fillna(0.0)
        b_total = b.iloc[-1] / b.iloc[0] - 1
        b_cagr = (b.iloc[-1] / b.iloc[0]) ** (1 / years) - 1 if b.iloc[-1] > 0 else -1
        cov = np.cov(rets, brets)
        beta = cov[0, 1] / cov[1, 1] if cov[1, 1] > 0 else 0.0
        alpha = (rets.mean() - rf_per - beta * (brets.mean() - rf_per)) * ppy
        active = rets - brets
        te = active.std(ddof=1) * math.sqrt(ppy)
        bdd = drawdown(b)
        m.update({
            "benchmark_return_pct": _f(b_total * 100, 2), "benchmark_cagr_pct": _f(b_cagr * 100, 2),
            "benchmark_max_dd_pct": _f(bdd.min(), 2),
            "alpha_pct": _f(alpha * 100, 2), "beta": _f(beta, 3),
            "correlation": _f(np.corrcoef(rets, brets)[0, 1], 3) if rets.std() > 0 and brets.std() > 0 else None,
            "information_ratio": _f(active.mean() * ppy / te, 3) if te > 0 else None,
            "tracking_error_pct": _f(te * 100, 2), "excess_return_pct": _f((total_ret - b_total) * 100, 2),
        })

    # --- day-level view (meaningful for intraday data and daily square-off) --- #
    daily = equity.resample("D").last().dropna()
    dr = daily.pct_change().dropna()
    dr = dr[dr != 0] if (dr != 0).any() else dr
    if len(dr):
        m.update({
            "trading_days": int(len(dr)),
            "profitable_days_pct": _f((dr > 0).mean() * 100, 2),
            "avg_day_return_pct": _f(dr.mean() * 100, 3),
            "best_day_pct": _f(dr.max() * 100, 2),
            "worst_day_pct": _f(dr.min() * 100, 2),
        })

    m.update(trade_stats(trades))
    m["_drawdowns"] = [
        {**d, "start": d["start"].isoformat(), "trough": d["trough"].isoformat(),
         "end": d["end"].isoformat() if d["end"] is not None else None,
         "depth_pct": _f(d["depth_pct"], 2)} for d in dd_episodes[:10]
    ]
    return m


def trade_stats(trades: list[dict]) -> dict:
    n = len(trades)
    if n == 0:
        return {"trades": 0, "win_rate_pct": None, "profit_factor": None, "expectancy": None,
                "avg_trade_pct": None, "avg_win_pct": None, "avg_loss_pct": None, "payoff_ratio": None,
                "best_trade_pct": None, "worst_trade_pct": None, "avg_bars_held": None,
                "max_consecutive_wins": 0, "max_consecutive_losses": 0, "sqn": None, "kelly_pct": None,
                "long_trades": 0, "short_trades": 0, "gross_profit": 0, "gross_loss": 0}
    pnl = np.array([t["pnl"] for t in trades])
    r = np.array([t["return_pct"] for t in trades])
    wins, losses = r[pnl > 0], r[pnl <= 0]
    gp, gl = pnl[pnl > 0].sum(), -pnl[pnl <= 0].sum()
    win_rate = len(wins) / n
    avg_w = wins.mean() if len(wins) else 0.0
    avg_l = losses.mean() if len(losses) else 0.0
    payoff = avg_w / abs(avg_l) if avg_l else None
    kelly = (win_rate - (1 - win_rate) / payoff) if payoff else None
    streak_w = streak_l = cw = cl = 0
    for p in pnl:
        if p > 0:
            cw, cl = cw + 1, 0
        else:
            cl, cw = cl + 1, 0
        streak_w, streak_l = max(streak_w, cw), max(streak_l, cl)
    sqn = math.sqrt(min(n, 100)) * r.mean() / r.std(ddof=1) if n > 1 and r.std(ddof=1) > 0 else None
    return {
        "trades": n, "win_rate_pct": _f(win_rate * 100, 2),
        "profit_factor": _f(gp / gl, 3) if gl > 0 else None,
        "expectancy": _f(pnl.mean(), 2), "avg_trade_pct": _f(r.mean(), 3),
        "avg_win_pct": _f(avg_w, 3), "avg_loss_pct": _f(avg_l, 3), "payoff_ratio": _f(payoff, 3),
        "best_trade_pct": _f(r.max(), 2), "worst_trade_pct": _f(r.min(), 2),
        "avg_bars_held": _f(np.mean([t["bars_held"] for t in trades]), 1),
        "max_consecutive_wins": int(streak_w), "max_consecutive_losses": int(streak_l),
        "sqn": _f(sqn, 3), "kelly_pct": _f(kelly * 100, 2) if kelly is not None else None,
        "long_trades": sum(1 for t in trades if t["side"] == "Long"),
        "short_trades": sum(1 for t in trades if t["side"] == "Short"),
        "gross_profit": _f(gp, 2), "gross_loss": _f(-gl, 2),
    }


def monthly_returns(equity: pd.Series) -> list[dict]:
    me = equity.resample("ME").last().dropna()
    first = equity.iloc[0]
    prev = pd.concat([pd.Series([first], index=[me.index[0] - pd.offsets.MonthEnd(1)]), me])
    mr = (prev.pct_change().dropna() * 100)
    return [{"year": int(d.year), "month": int(d.month), "ret": _f(v, 2)} for d, v in mr.items()]


def yearly_returns(equity: pd.Series, benchmark: pd.Series | None = None) -> list[dict]:
    def yr(s):
        ye = s.resample("YE").last().dropna()
        prev = pd.concat([pd.Series([s.iloc[0]], index=[ye.index[0] - pd.offsets.YearEnd(1)]), ye])
        return prev.pct_change().dropna() * 100
    a = yr(equity)
    b = yr(benchmark.reindex(equity.index).ffill().bfill()) if benchmark is not None else None
    return [{"year": int(d.year), "ret": _f(v, 2),
             "bench": _f(b.get(d), 2) if b is not None else None} for d, v in a.items()]


def rolling_stats(equity: pd.Series, ppy: float, window: int | None = None) -> dict:
    rets = equity.pct_change().fillna(0.0)
    w = window or max(int(ppy / 2), 20)
    w = min(w, max(len(rets) // 3, 5))
    roll_mean = rets.rolling(w).mean()
    roll_std = rets.rolling(w).std()
    sharpe = (roll_mean / roll_std * math.sqrt(ppy)).replace([np.inf, -np.inf], np.nan)
    vol = roll_std * math.sqrt(ppy) * 100
    return {"window": w, "sharpe": sharpe, "volatility": vol}


def periods_per_year(index: pd.DatetimeIndex, interval: str, trading_days: int) -> float:
    if interval == "1wk":
        return 52.0
    if interval == "1mo":
        return 12.0
    if interval == "1d" or len(index) < 3:
        # Infer: if data contains weekends (crypto), use 365.
        if interval == "1d":
            return float(trading_days)
    days = pd.Series(index.normalize()).value_counts()
    bars_per_day = float(days.median()) if len(days) else 1.0
    return float(trading_days * max(bars_per_day, 1.0))
