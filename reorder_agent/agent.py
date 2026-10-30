import os

import requests
from google.adk.agents import Agent

# ---------------------------------------------------------------
# 1. INVENTORY DATABASE (sample data, will move to Cloud SQL next sprint)
# ---------------------------------------------------------------
INVENTORY = [
    {"name": "Olive Oil 5L", "category": "oil", "stock": 40, "daily_usage": 10, "lead_time_days": 3,
     "unit_cost": 18.5, "supplier": "Ege Olive Co.", "supplier_city": "Izmir", "lat": 38.42, "lon": 27.14},
    {"name": "Rice 25kg", "category": "grain", "stock": 200, "daily_usage": 15, "lead_time_days": 10,
     "unit_cost": 32.0, "supplier": "Basmati Exports", "supplier_city": "Mumbai", "lat": 19.08, "lon": 72.88},
    {"name": "Coffee Beans 1kg", "category": "coffee", "stock": 20, "daily_usage": 10, "lead_time_days": 7,
     "unit_cost": 14.0, "supplier": "Santos Roasters", "supplier_city": "Sao Paulo", "lat": -23.55, "lon": -46.63},
    {"name": "Packaging Boxes", "category": "box", "stock": 500, "daily_usage": 40, "lead_time_days": 5,
     "unit_cost": 0.8, "supplier": "Pearl River Pack", "supplier_city": "Shanghai", "lat": 31.23, "lon": 121.47},
    {"name": "Flour 50kg", "category": "flour", "stock": 120, "daily_usage": 12, "lead_time_days": 4,
     "unit_cost": 27.0, "supplier": "Hanse Mills", "supplier_city": "Hamburg", "lat": 53.55, "lon": 9.99},
]


# ---------------------------------------------------------------
# 2. TOOL: read inventory
# ---------------------------------------------------------------
def get_inventory() -> list:
    """Returns all products with their current stock, daily usage,
    supplier lead time in days, unit cost, supplier name and supplier city."""
    return INVENTORY


# ---------------------------------------------------------------
# 3. TOOL: weather risk for a supplier city
# ---------------------------------------------------------------
def get_weather_risk(city: str) -> dict:
    """Checks the 7-day weather forecast for a supplier city and estimates
    how many extra days of shipping delay bad weather could cause."""
    try:
        geo = requests.get(
            "https://geocoding-api.open-meteo.com/v1/search",
            params={"name": city, "count": 1},
            timeout=10,
        ).json()

        if not geo.get("results"):
            return {"city": city, "error": "City not found"}

        lat = geo["results"][0]["latitude"]
        lon = geo["results"][0]["longitude"]

        weather = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": lat,
                "longitude": lon,
                "daily": "precipitation_sum,wind_speed_10m_max",
                "forecast_days": 7,
            },
            timeout=10,
        ).json()

        max_rain = max(weather["daily"]["precipitation_sum"])
        max_wind = max(weather["daily"]["wind_speed_10m_max"])

        return {
            "city": city,
            "max_rain_mm": max_rain,
            "max_wind_kmh": max_wind,
            "expected_delay_days": delay_from_weather(max_rain, max_wind),
        }
    except Exception as e:
        return {"city": city, "error": str(e)}


def delay_from_weather(max_rain: float, max_wind: float) -> int:
    """Rule: heavy rain or strong wind slows shipping down."""
    if max_rain > 20 or max_wind > 50:
        return 3
    if max_rain > 10 or max_wind > 35:
        return 1
    return 0


# ---------------------------------------------------------------
# 4. TOOL: calculate stock-out risk (math in Python, not the LLM)
# ---------------------------------------------------------------
def calculate_risk(stock: int, daily_usage: int, lead_time_days: int, expected_delay_days: int) -> dict:
    """Calculates how many days of stock are left and compares it with
    the total time a new order would take to arrive. Returns a risk level
    (HIGH, MEDIUM, LOW) and a suggested order quantity."""
    days_left = stock / daily_usage if daily_usage else 999
    arrival_days = lead_time_days + expected_delay_days

    if days_left < arrival_days:
        risk = "HIGH"
    elif days_left < arrival_days + 3:
        risk = "MEDIUM"
    else:
        risk = "LOW"

    suggested_qty = max(0, int(daily_usage * (arrival_days + 14) - stock))

    return {
        "days_of_stock_left": round(days_left, 1),
        "days_until_new_order_arrives": arrival_days,
        "risk_level": risk,
        "suggested_order_quantity": suggested_qty,
    }


# ---------------------------------------------------------------
# 5. THE AGENT
# ---------------------------------------------------------------
# The model can be changed in reorder_agent/.env with GEMINI_MODEL=...
# (useful when the free daily quota of one model is used up).
MODEL = os.getenv("GEMINI_MODEL", "gemini-3.6-flash")

root_agent = Agent(
    name="reorder_monitor_agent",
    model=MODEL,
    description="Monitors inventory and external risks to prevent stock shortages.",
    instruction="""
You are ReorderAI, an assistant that helps small businesses avoid stock shortages.

When the user asks you to check stock or risks:
1. Call get_inventory to get all products.
2. For each product, call get_weather_risk with its supplier_city.
3. For each product, call calculate_risk using its stock, daily_usage,
   lead_time_days and the expected_delay_days from the weather result
   (use 0 if the weather check returned an error).
4. Show a short table: product, days of stock left, weather delay, risk level.
5. For every HIGH or MEDIUM risk product, write a draft purchase order:
   - Product, supplier, supplier city, suggested quantity, estimated cost
     (quantity x unit_cost), risk level, short reason.
   - Clearly mark it: "STATUS: AWAITING HUMAN APPROVAL".
6. Never say an order was placed. You only draft orders; a human approves them.

For other questions (one product, one city, what-if scenarios), call only the
tools you need. Keep answers clear and short.
""",
    tools=[get_inventory, get_weather_risk, calculate_risk],
)
