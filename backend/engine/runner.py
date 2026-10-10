"""High-level service: request dict → data → backtest → analytics → JSON."""
from __future__ import annotations

import math
import uuid
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import data as datamod
from .core import Backtester, EngineConfig, TradingRules
from .costs import CostModel
from .library import LIBRARY
from .markets import get_market
from .metrics import (compute_metrics, monthly_returns, periods_per_year, rolling_stats, trade_stats,
                      yearly_returns)
from .montecarlo import block_bootstrap, trade_bootstrap
from .sandbox import load_strategy
from .strategy import Strategy


# --------------------------------------------------------------------------- #
# Request parsing
# --------------------------------------------------------------------------- #
def resolve_strategy(spec: dict) -> type[Strategy]:
    sid = spec.get("id") or "SmaCross"
    if sid == "custom" or spec.get("code"):
        return load_strategy(spec.get("code") or "")
    if sid not in LIBRARY:
        raise ValueError(f"Unknown strategy '{sid}'")
    return LIBRARY[sid]


def coerce_params(cls: type[Strategy], params: dict | None) -> dict:
    out = {}
    for k, v in (params or {}).items():
        if k not in cls.params:
            continue
        default = cls.params[k]
        try:
            if isinstance(default, bool):
                out[k] = v if isinstance(v, bool) else str(v).lower() in ("1", "true", "yes", "on")
            elif isinstance(default, int):
                out[k] = int(round(float(v)))
            elif isinstance(default, float):
                out[k] = float(v)
            else:
                out[k] = v
        except (TypeError, ValueError):
            out[k] = default
    return out


def build_config(req: dict, market, ppy: float) -> EngineConfig:
    c = req.get("cost") or {}
    explicit = bool(c.get("kind"))
    kind = c.get("kind") or market.cost_model
    default_rate = {"india_delivery": 0.0, "india_intraday": 0.03}.get(kind, 0.1)
    rate_pct = float(c.get("rate_pct", default_rate)) if explicit else default_rate
    cost = CostModel(kind=kind, rate=rate_pct / 100,
                     fixed=float(c.get("fixed", 0) or 0), per_share=float(c.get("per_share", 0) or 0),
                     minimum=float(c.get("minimum", 0) or 0), maximum=float(c.get("maximum", 0) or 0))
    sizing = req.get("sizing") or {}
    stops = req.get("stops") or {}
    frac = req.get("fractional")
    rules = build_rules(req)
    return EngineConfig(
        initial_capital=float(req.get("capital", 100_000)),
        cost=cost,
        slippage_pct=float(req.get("slippage_pct", 0.05)) / 100,
        fill_on=req.get("fill_on", "next_open"),
        allow_short=bool(req.get("allow_short", False)),
        leverage=max(float(req.get("leverage", 1.0)), 0.01),
        fractional=market.fractional if frac is None else bool(frac),
        lot_size=float(req.get("lot_size", 1) or 1),
        sizing_mode=sizing.get("mode", "percent"),
        sizing_value=float(sizing.get("value", 100)),
        pyramiding=max(int(req.get("pyramiding", 1)), 1),
        stop_loss_pct=float(stops.get("stop_loss_pct", 0) or 0),
        take_profit_pct=float(stops.get("take_profit_pct", 0) or 0),
        trailing_pct=float(stops.get("trailing_pct", 0) or 0),
        max_bars_in_trade=int(stops.get("max_bars", 0) or 0),
        max_volume_pct=float(req.get("max_volume_pct", 0) or 0),
        close_at_end=bool(req.get("close_at_end", True)),
        risk_free_rate=float(req.get("risk_free_pct", 0) or 0) / 100,
        periods_per_year=ppy,
        rules=rules,
    )


def build_rules(req: dict) -> TradingRules:
    r = req.get("rules") or {}
    num = lambda k: max(float(r.get(k) or 0), 0.0)
    direction = r.get("direction") or ("both" if req.get("allow_short") else "long")
    return TradingRules(
        direction=direction if direction in ("both", "long", "short") else "long",
        sizing_base="fixed" if r.get("sizing_base") == "fixed" else "compound",
        square_off=bool(r.get("square_off")),
        square_off_time=str(r.get("square_off_time") or "") if r.get("square_off") else "",
        entry_start=str(r.get("entry_start") or ""),
        entry_end=str(r.get("entry_end") or ""),
        daily_capital_limit=num("daily_capital_limit"),
        daily_capital_mode="pct" if r.get("daily_capital_mode") == "pct" else "amount",
        max_trades_per_day=int(num("max_trades_per_day")),
        max_open_positions=int(num("max_open_positions")),
        max_position_pct=num("max_position_pct"),
        daily_loss_limit_pct=num("daily_loss_limit_pct"),
        daily_profit_target_pct=num("daily_profit_target_pct"),
        max_drawdown_stop_pct=num("max_drawdown_stop_pct"),
        cooldown_bars=int(num("cooldown_bars")),
    )


def load_frames(req: dict) -> tuple[dict[str, pd.DataFrame], list[str]]:
    market = get_market(req.get("market"))
    source = req.get("source", "yahoo")
    symbols = [s.strip() for s in req.get("symbols", []) if s and s.strip()]
    if not symbols:
        raise ValueError("Select at least one symbol")
    if len(symbols) > 50:
        raise ValueError("At most 50 symbols per backtest")
    frames, warnings = {}, []
    for s in symbols:
        try:
            sym, df = datamod.load(source, market.code, s, req.get("start"), req.get("end"),
                                   req.get("interval", "1d"), req.get("adjusted", True), req.get("refresh", False))
            frames[sym] = df
        except datamod.DataError as e:
            warnings.append(str(e))
    if not frames:
        raise datamod.DataError("; ".join(warnings) or "No data loaded")
    return frames, warnings


def load_benchmark(req: dict, frames: dict[str, pd.DataFrame]) -> tuple[str | None, pd.Series | None]:
    market = get_market(req.get("market"))
    bm = (req.get("benchmark") or "auto").strip()
    if bm.lower() == "none":
        return None, None
    if bm.lower() == "auto":
        bm = market.benchmark
    if bm and req.get("source", "yahoo") == "yahoo":
        try:
            df = datamod.load_yahoo(bm, req.get("start"), req.get("end"),
                                    req.get("interval", "1d") if req.get("interval") in ("1d", "1wk", "1mo") else "1d")
            return bm, df["close"]
        except Exception:
            pass
    # Fallback: equal-weight buy & hold of the universe.
    closes = pd.DataFrame({s: f["close"] for s, f in frames.items()}).ffill()
    norm = closes / closes.bfill().iloc[0]
    return "Universe B&H", norm.mean(axis=1) * 100


# --------------------------------------------------------------------------- #
# Running
# --------------------------------------------------------------------------- #
def run_core(frames, cls, params, cfg) -> dict:
    return Backtester(frames, cls, params, cfg).run()


def run_backtest(req: dict, include_mc: bool = True) -> dict:
    market = get_market(req.get("market"))
    cls = resolve_strategy(req.get("strategy") or {})
    params = coerce_params(cls, (req.get("strategy") or {}).get("params"))
    frames, warnings = load_frames(req)
    if not cls.per_asset and len(frames) < 2 and "Portfolio" in (cls.category or ""):
        warnings.append("Portfolio strategies work best with 2 or more symbols.")
    first_index = next(iter(frames.values())).index
    ppy = periods_per_year(first_index, req.get("interval", "1d"), market.trading_days)
    cfg = build_config(req, market, ppy)
    if cfg.rules.square_off and cfg.fill_on == "close" and req.get("interval", "1d") in ("1d", "1wk", "1mo"):
        warnings.append("Daily square-off with same-bar-close fills can't open any trades on daily bars (they would be "
                        "held overnight). Use 'Next bar open' fills to enter at the open and square off at the close.")
    if cfg.rules.square_off and req.get("interval", "1d") in ("1wk", "1mo"):
        warnings.append("Square-off works per trading day; on weekly/monthly bars it closes positions at every bar.")
    res = run_core(frames, cls, params, cfg)
    bm_name, bm = load_benchmark(req, frames)
    return assemble(req, cls, params, cfg, res, bm_name, bm, market, warnings, include_mc)


def _ts(idx) -> list[int]:
    return pd.DatetimeIndex(idx).as_unit("s").asi8.astype(np.int64).tolist()


def _arr(a, nd=4) -> list:
    a = np.asarray(a, dtype=float)
    r = np.round(a, nd)
    return [None if not math.isfinite(v) else float(v) for v in r]


def _clean(o):
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (pd.Timestamp, datetime)):
        return o.isoformat()
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        v = float(o)
        return None if not math.isfinite(v) else round(v, 6)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


def explain_no_trades(cls, cfg, res) -> str | None:
    """A plain-language reason when a backtest produced no trades at all."""
    if res["trades"] or res.get("open_positions"):
        return None
    ev = res.get("rule_events", {})
    bars = len(res["index"])
    other = {k: v for k, v in ev.items() if k.startswith(("blocked_", "capped_"))
             and k not in ("blocked_short_signal", "blocked_long_signal")}
    if ev.get("blocked_long_signal") and not cfg.allow_long:
        return (f"No trades: '{cls.name}' only produced buy signals, but Trading rules are set to Short only. "
                "Switch Direction to Long only or Both, or pick a strategy that can go short.")
    if ev.get("blocked_short_signal") and not cfg.allow_short and not other:
        return (f"No trades: '{cls.name}' only produced sell signals while it had no position, and Trading rules "
                "are set to Long only. Set Direction to Both to trade them as shorts.")
    if other:
        names = ", ".join(k.replace("blocked_", "").replace("capped_", "").replace("_", " ") for k in other)
        return f"No trades: every entry was blocked by your trading rules ({names}). Relax those rules to see trades."
    starved = res.get("starved_indicators") or []
    if starved:
        return (f"No trades: {', '.join(starved[:3])} never had enough history to produce a value with only {bars} "
                "bars loaded. Use a longer date range or shorter indicator periods.")
    if res.get("warmup", 0) >= bars - 1:
        return (f"No trades: the strategy's indicators need about {res.get('warmup', 0)} bars of history, but only "
                f"{bars} bars were loaded. Use a longer date range or shorter indicator periods.")
    return ("No trades: the strategy never generated an entry signal in this period. "
            "Try a longer date range or different parameters.")


def assemble(req, cls, params, cfg, res, bm_name, bm, market, warnings, include_mc=True) -> dict:
    eq: pd.Series = res["equity"]
    why = explain_no_trades(cls, cfg, res)
    if why:
        warnings = [why] + list(warnings)
    bench_eq = None
    if bm is not None:
        b = bm.reindex(eq.index).ffill().bfill()
        if b.notna().any() and b.iloc[0] > 0:
            bench_eq = b / b.iloc[0] * cfg.initial_capital
    metrics = compute_metrics(eq, res["trades"], cfg.periods_per_year, cfg.risk_free_rate, bench_eq,
                              res["exposure"], res["fees"])
    drawdowns = metrics.pop("_drawdowns")
    dd = (eq / eq.cummax() - 1) * 100
    roll = rolling_stats(eq, cfg.periods_per_year)
    t = _ts(eq.index)

    # Per-symbol price data, indicators and trade markers.
    symbols = {}
    ind_by_sym: dict[str, list] = {}
    for ind in res["indicators"]:
        ind_by_sym.setdefault(ind["symbol"], []).append(ind)
    per_symbol_stats = []
    for s, f in res["frames"].items():
        sym_trades = [tr for tr in res["trades"] if tr["symbol"] == s]
        symbols[s] = {
            "open": _arr(f["open"]), "high": _arr(f["high"]), "low": _arr(f["low"]), "close": _arr(f["close"]),
            "volume": _arr(f["volume"], 0),
            "indicators": [{"name": i["name"], "overlay": i["overlay"], "color": i["color"],
                            "values": _arr(i["values"])} for i in ind_by_sym.get(s, [])],
        }
        st = trade_stats(sym_trades)
        bh = f["close"].dropna()
        per_symbol_stats.append({
            "symbol": s, "trades": st["trades"], "win_rate_pct": st["win_rate_pct"],
            "net_pnl": round(sum(tr["pnl"] for tr in sym_trades), 2), "profit_factor": st["profit_factor"],
            "avg_trade_pct": st["avg_trade_pct"],
            "buy_hold_pct": round(float(bh.iloc[-1] / bh.iloc[0] - 1) * 100, 2) if len(bh) > 1 else None,
        })

    trades = []
    for tr in res["trades"]:
        trades.append({**tr, "entry_time": int(pd.Timestamp(tr["entry_time"]).timestamp()),
                       "exit_time": int(pd.Timestamp(tr["exit_time"]).timestamp())})
    fills = [{**f, "time": int(pd.Timestamp(f["time"]).timestamp())} for f in res["fills"][-5000:]]

    exit_reasons: dict[str, int] = {}
    for tr in res["trades"]:
        exit_reasons[tr["exit_reason"]] = exit_reasons.get(tr["exit_reason"], 0) + 1

    mc = {}
    if include_mc:
        mc = {"returns": block_bootstrap(eq, n_sims=500), "trades": trade_bootstrap(res["trades"], eq, n_sims=1000)}

    rets = eq.pct_change().dropna() * 100
    out = {
        "id": uuid.uuid4().hex[:12],
        "created": datetime.now(timezone.utc).isoformat(),
        "strategy": {"id": (req.get("strategy") or {}).get("id"), "name": cls.name, "params": {**cls.params, **params},
                     "per_asset": cls.per_asset},
        "request": {k: v for k, v in req.items() if k != "refresh"},
        "market": market.to_dict(),
        "currency": market.currency if req.get("source") != "csv" else req.get("currency", market.currency),
        "metrics": metrics,
        "series": {
            "t": t, "equity": _arr(eq, 2), "benchmark": _arr(bench_eq, 2) if bench_eq is not None else None,
            "drawdown": _arr(dd, 3), "exposure": _arr(res["exposure"] * 100, 2), "cash": _arr(res["cash"], 2),
            "rolling_sharpe": _arr(roll["sharpe"], 3), "rolling_vol": _arr(roll["volatility"], 3),
            "rolling_window": roll["window"],
        },
        "benchmark_name": bm_name,
        "returns_dist": _arr(rets, 4),
        "monthly": monthly_returns(eq),
        "yearly": yearly_returns(eq, bench_eq),
        "drawdowns": drawdowns,
        "trades": trades,
        "fills": fills,
        "exit_reasons": exit_reasons,
        "rule_events": res.get("rule_events", {}),
        "rules_active": res.get("rules_active", []),
        "per_symbol": per_symbol_stats,
        "symbols": symbols,
        "open_positions": res["open_positions"],
        "logs": res["logs"][-500:],
        "monte_carlo": mc,
        "warnings": warnings,
        "elapsed_ms": round(res["elapsed"] * 1000, 1),
        "config": {"periods_per_year": cfg.periods_per_year, "cost_model": cfg.cost.kind,
                   "fractional": cfg.fractional, "fill_on": cfg.fill_on},
    }
    return _clean(out)
