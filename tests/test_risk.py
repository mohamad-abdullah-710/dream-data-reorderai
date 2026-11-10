
"""Tests for inventory risk calculation."""

import pytest

from reorder_agent.agent import calculate_risk


def test_high_risk_when_stock_runs_out_before_delivery():
    result = calculate_risk(
        stock=20,
        daily_usage=10,
        lead_time_days=5,
        expected_delay_days=0,
    )

    assert result["risk_level"] == "HIGH"
    assert result["days_of_stock_left"] == 2.0
    assert result["suggested_order_quantity"] == 170


def test_low_risk_when_stock_is_sufficient():
    result = calculate_risk(
        stock=200,
        daily_usage=10,
        lead_time_days=3,
        expected_delay_days=0,
    )

    assert result["risk_level"] == "LOW"
    assert result["suggested_order_quantity"] == 0


@pytest.mark.parametrize(
    "stock,daily_usage,lead_time_days,expected_delay_days",
    [
        (-10, 5, 3, 0),
        (100, -5, 3, 0),
        (100, 5, -3, 0),
        (100, 5, 3, -2),
    ],
)
def test_negative_inputs_are_rejected(
    stock, daily_usage, lead_time_days, expected_delay_days
):
    with pytest.raises(ValueError):
        calculate_risk(
            stock=stock,
            daily_usage=daily_usage,
            lead_time_days=lead_time_days,
            expected_delay_days=expected_delay_days,
        )


def test_zero_daily_usage_does_not_return_fake_stock_duration():
    result = calculate_risk(
        stock=100,
        daily_usage=0,
        lead_time_days=3,
        expected_delay_days=0,
    )

    assert result["days_of_stock_left"] is None
    assert result["risk_level"] == "LOW"
    assert result["suggested_order_quantity"] == 0
