"""Transaction cost models.

A cost model takes ``(side, qty, price)`` and returns the total charges in
account currency for that fill. Indian models implement the statutory charge
stack (brokerage, STT, exchange transaction charges, SEBI fee, stamp duty and
GST) so NSE/BSE results are realistic out of the box.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class CostModel:
    kind: str = "percent"
    rate: float = 0.001        # percent model: fraction of notional (0.001 = 0.1%)
    fixed: float = 0.0         # flat fee per order
    per_share: float = 0.0     # per unit fee
    minimum: float = 0.0       # minimum fee per order
    maximum: float = 0.0       # cap on brokerage (0 = no cap)

    def __call__(self, side: str, qty: float, price: float) -> float:
        qty = abs(qty)
        notional = qty * price
        if notional <= 0:
            return 0.0
        k = self.kind
        if k == "none":
            return 0.0
        if k == "percent":
            fee = notional * self.rate + self.fixed
        elif k == "fixed":
            fee = self.fixed
        elif k == "per_share":
            fee = qty * self.per_share + self.fixed
        elif k == "us_equity":
            # IBKR-style tiered-ish: $0.005/share, min $1, max 1% of notional
            fee = min(max(qty * 0.005, 1.0), notional * 0.01)
            if side == "sell":
                fee += notional * 0.0000278 + min(qty * 0.000166, 8.30)  # SEC + FINRA TAF
            return fee
        elif k == "india_delivery":
            return _india(side, notional, delivery=True, brokerage_rate=self.rate, brokerage_cap=self.maximum or 20.0)
        elif k == "india_intraday":
            return _india(side, notional, delivery=False, brokerage_rate=self.rate or 0.0003, brokerage_cap=self.maximum or 20.0)
        elif k == "india_futures":
            return _india_fut(side, notional)
        else:
            fee = notional * self.rate
        fee = max(fee, self.minimum)
        if self.maximum:
            fee = min(fee, self.maximum)
        return fee


def _india(side: str, notional: float, delivery: bool, brokerage_rate: float, brokerage_cap: float) -> float:
    brokerage = min(notional * brokerage_rate, brokerage_cap) if brokerage_rate else 0.0
    if delivery:
        stt = notional * 0.001                                   # 0.1% on buy & sell
        stamp = notional * 0.00015 if side == "buy" else 0.0     # 0.015% on buy
    else:
        stt = notional * 0.00025 if side == "sell" else 0.0      # 0.025% on sell
        stamp = notional * 0.00003 if side == "buy" else 0.0     # 0.003% on buy
    exch = notional * 0.0000297                                  # NSE txn charge
    sebi = notional * 10 / 1e7                                   # ₹10 per crore
    gst = 0.18 * (brokerage + exch + sebi)
    return brokerage + stt + stamp + exch + sebi + gst


def _india_fut(side: str, notional: float) -> float:
    brokerage = 20.0
    stt = notional * 0.0002 if side == "sell" else 0.0
    stamp = notional * 0.00002 if side == "buy" else 0.0
    exch = notional * 0.0000173
    sebi = notional * 10 / 1e7
    gst = 0.18 * (brokerage + exch + sebi)
    return brokerage + stt + stamp + exch + sebi + gst


COST_MODELS = [
    {"id": "none", "label": "Zero cost"},
    {"id": "percent", "label": "Percent of notional"},
    {"id": "fixed", "label": "Flat fee per order"},
    {"id": "per_share", "label": "Per share / unit"},
    {"id": "us_equity", "label": "US equity (IBKR-style + SEC/FINRA)"},
    {"id": "india_delivery", "label": "India equity delivery (STT, stamp, GST…)"},
    {"id": "india_intraday", "label": "India equity intraday"},
    {"id": "india_futures", "label": "India futures"},
]
