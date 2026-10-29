import requests
from google.adk.agents import Agent

# ---------------------------------------------------------------
# 1. FAKE INVENTORY DATABASE (will move to Cloud SQL next sprint)
# ---------------------------------------------------------------
INVENTORY = [
    {"name": "Olive Oil 5L", "stock": 40, "daily_usage": 10, "lead_time_days": 3, "supplier_city": "Izmir"},
    {"name": "Rice 25kg", "stock": 200, "daily_usage": 15, "lead_time_days": 10, "supplier_city": "Mumbai"},
    {"name": "Coffee Beans 1kg", "stock": 20, "daily_usage": 10, "lead_time_days": 7, "supplier_city": "Sao Paulo"},
    {"name": "Packaging Boxes", "stock": 500, "daily_usage": 40, "lead_time_days": 5, "supplier_city": "Shanghai"},
    {"name": "Flour 50kg", "stock": 120, "daily_usage": 12, "lead_time_days": 4, "supplier_city": "Hamburg"},
]


# ---------------------------------------------------------------
# 2. TOOL: read inventory
# ---------------------------------------------------------------
def get_inventory() -> list:
    """Returns all products with their current stock, daily usage,
    supplier lead time in days, and supplier city."""
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

        if max_rain > 20 or max_wind > 50:
            delay = 3
        elif max_rain > 10 or max_wind > 35:
            delay = 1
        else:
            delay = 0

        return {
            "city": city,
            "max_rain_mm": max_rain,
            "max_wind_kmh": max_wind,
            "expected_delay_days": delay,
        }
    except Exception as e:
        return {"city": city, "error": str(e)}


# ---------------------------------------------------------------
# 4. TOOL: calculate stock-out risk (math in Python, not the LLM)
# ---------------------------------------------------------------
def calculate_risk(stock: int, daily_usage: int, lead_time_days: int, expected_delay_days: int) -> dict:
    """Calculates how many days of stock are left and compares it with
    the total time a new order would take to arrive. Returns a risk level
    (HIGH, MEDIUM, LOW) and a suggested order quantity."""
    days_left = stock / daily_usage
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
root_agent = Agent(
    name="reorder_monitor_agent",
    model="gemini-3.6-flash",
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
   - Product, supplier city, suggested quantity, risk level, short reason.
   - Clearly mark it: "STATUS: AWAITING HUMAN APPROVAL".
6. Never say an order was placed. You only draft orders; a human approves them.

Keep answers clear and short.
""",
    tools=[get_inventory, get_weather_risk, calculate_risk],
)
