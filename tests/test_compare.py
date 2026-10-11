import pytest

from backend.engine.compare import compare
from backend.engine.runner import run_backtest

BASE = {"source": "synthetic", "market": "US", "symbols": ["CMP_A"], "start": "2016-01-01", "end": "2021-01-01",
        "capital": 100_000, "benchmark": "none"}
BROKEN = "class Broken(Strategy):\n    def next(self)\n        pass\n"


def test_compare_matches_single_backtests():
    specs = [{"id": "BuyAndHold"}, {"id": "SmaCross"}, {"id": "SmaCross", "params": {"fast": 5, "slow": 30}, "label": "Fast SMA"}]
    res = compare({**BASE, "strategies": specs})
    assert [e["label"] for e in res["strategies"]] == ["Buy & Hold", "SMA Crossover", "Fast SMA"]
    for spec, e in zip(specs, res["strategies"]):
        single = run_backtest({**BASE, "strategy": {"id": spec["id"], "params": spec.get("params", {})}}, include_mc=False)
        assert e["metrics"]["total_return_pct"] == single["metrics"]["total_return_pct"]
        assert e["metrics"]["trades"] == single["metrics"]["trades"]
        assert len(e["equity"]) == len(res["t"])


def test_blend_is_mean_of_bar_returns():
    res = compare({**BASE, "strategies": [{"id": "BuyAndHold"}, {"id": "RsiReversion"}]})
    a, b = (e["equity"] for e in res["strategies"])
    blend = res["blend"]["equity"]
    eq = 100_000.0
    for k in range(1, len(blend)):
        eq *= 1 + ((a[k] / a[k - 1] - 1) + (b[k] / b[k - 1] - 1)) / 2
    assert blend[-1] == pytest.approx(eq, rel=1e-3)
    assert res["blend"]["trades"] is None


def test_duplicate_labels_are_made_unique():
    res = compare({**BASE, "strategies": [{"id": "SmaCross"}, {"id": "SmaCross"}]})
    assert [e["label"] for e in res["strategies"]] == ["SMA Crossover", "SMA Crossover #2"]


def test_broken_strategy_does_not_sink_the_rest():
    res = compare({**BASE, "strategies": [{"id": "SmaCross"}, {"id": "custom", "code": BROKEN}, {"id": "MacdCross"}]})
    errs = [e for e in res["strategies"] if e.get("error")]
    assert len(errs) == 1 and "SyntaxError" in errs[0]["error"]
    assert sum(1 for e in res["strategies"] if not e.get("error")) == 2 and res["blend"] is not None


@pytest.mark.parametrize("n", [1, 9])
def test_strategy_count_limits(n):
    with pytest.raises(ValueError):
        compare({**BASE, "strategies": [{"id": "SmaCross"}] * n})
