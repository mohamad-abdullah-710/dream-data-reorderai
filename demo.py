"""Fallback demo for ReorderAI.

Runs the same tools the agent uses (inventory, live weather, risk calculation)
directly in Python, without calling Gemini. Useful when the LLM API is busy.

Run from the project root:  python demo.py
"""

from reorder_agent.agent import get_inventory, get_weather_risk, calculate_risk

print("\n========== ReorderAI - Stock Risk Report ==========\n")
print(f"{'Product':<20}{'Days left':<12}{'Weather delay':<16}{'Risk':<8}")
print("-" * 56)

orders = []

for product in get_inventory():
    weather = get_weather_risk(product["supplier_city"])
    delay = weather.get("expected_delay_days", 0)

    risk = calculate_risk(
        product["stock"],
        product["daily_usage"],
        product["lead_time_days"],
        delay,
    )

    print(
        f"{product['name']:<20}"
        f"{risk['days_of_stock_left']:<12}"
        f"{str(delay) + ' days':<16}"
        f"{risk['risk_level']:<8}"
    )

    if risk["risk_level"] in ("HIGH", "MEDIUM"):
        orders.append((product, weather, risk))

print("\n========== Draft Purchase Orders ==========\n")

if not orders:
    print("No risky products. No orders needed.")

for product, weather, risk in orders:
    print(f"Product:   {product['name']}")
    print(f"Supplier:  {product['supplier_city']}")
    print(f"Quantity:  {risk['suggested_order_quantity']} units")
    print(f"Risk:      {risk['risk_level']}")
    print(
        f"Reason:    Only {risk['days_of_stock_left']} days of stock left, "
        f"but a new order needs {risk['days_until_new_order_arrives']} days to arrive "
        f"(weather: rain {weather.get('max_rain_mm', '?')}mm, "
        f"wind {weather.get('max_wind_kmh', '?')}km/h)."
    )
    print("STATUS:    AWAITING HUMAN APPROVAL")
    print("-" * 56)
