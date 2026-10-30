"""ReorderAI dashboard server.

Runs a local web dashboard on top of the ReorderAI agent tools:
live supplier weather, stock-out risk, draft purchase orders with
approve / reject, a what-if simulator and an AI assistant chat.

Run from the project root:   python app.py
Then open:                   http://127.0.0.1:8080

Only uses packages that are already installed with google-adk.
"""

import asyncio
import inspect
import json
import mimetypes
import os
import sys
import threading
import time
import uuid
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"

# Load the API key (and optional GEMINI_MODEL) before the agent is imported.
try:
    from dotenv import load_dotenv

    load_dotenv(ROOT / "reorder_agent" / ".env")
except ImportError:
    pass

from reorder_agent.agent import (  # noqa: E402
    INVENTORY,
    MODEL,
    calculate_risk,
    get_weather_risk,
    root_agent,
)

# Windows sometimes maps .js to text/plain, so set the common types explicitly.
TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
         ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon"}

APP_NAME = "reorderai"
USER_ID = "demo-user"
CACHE_SECONDS = 600

# ---------------------------------------------------------------
# Live data (weather + risk), cached so the page loads fast
# ---------------------------------------------------------------
_cache = {"time": 0.0, "data": None}
_cache_lock = threading.Lock()

# Purchase order decisions made by the human in the dashboard.
_orders = {}
_orders_lock = threading.Lock()


def _forecast(product: dict) -> list:
    """7-day forecast for the supplier location (used for the mini charts)."""
    try:
        data = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": product["lat"],
                "longitude": product["lon"],
                "daily": "precipitation_sum,wind_speed_10m_max,temperature_2m_max,weather_code",
                "forecast_days": 7,
                "timezone": "auto",
            },
            timeout=10,
        ).json()["daily"]
        return [
            {
                "date": data["time"][i],
                "rain": data["precipitation_sum"][i],
                "wind": data["wind_speed_10m_max"][i],
                "temp": data["temperature_2m_max"][i],
                "code": data["weather_code"][i],
            }
            for i in range(len(data["time"]))
        ]
    except Exception:
        return []


def _analyse(product: dict) -> dict:
    """Runs the same tools the agent uses for one product."""
    weather = get_weather_risk(product["supplier_city"])
    delay = weather.get("expected_delay_days", 0)
    risk = calculate_risk(product["stock"], product["daily_usage"], product["lead_time_days"], delay)
    return {
        **product,
        "weather": weather,
        "weather_ok": "error" not in weather,
        "forecast": _forecast(product),
        "risk": risk,
        "order_value": round(risk["suggested_order_quantity"] * product.get("unit_cost", 0), 2),
    }


def build_dashboard(force: bool = False) -> dict:
    with _cache_lock:
        fresh = _cache["data"] and time.time() - _cache["time"] < CACHE_SECONDS
        if fresh and not force:
            data = _cache["data"]
        else:
            with ThreadPoolExecutor(max_workers=5) as pool:
                products = list(pool.map(_analyse, INVENTORY))
            data = {"products": products, "generated_at": datetime.now().isoformat(timespec="seconds")}
            _cache.update(time=time.time(), data=data)

    with _orders_lock:
        orders = dict(_orders)
    for p in data["products"]:
        decision = orders.get(p["name"])
        p["order_status"] = decision["status"] if decision else (
            "pending" if p["risk"]["risk_level"] in ("HIGH", "MEDIUM") else "none")
        p["order_decided_at"] = decision["at"] if decision else None

    return {
        **data,
        "model": MODEL,
        "ai_ready": bool(os.getenv("GOOGLE_API_KEY")),
    }


# ---------------------------------------------------------------
# AI assistant (Google ADK runner on one background event loop)
# ---------------------------------------------------------------
_loop = asyncio.new_event_loop()
threading.Thread(target=_loop.run_forever, daemon=True).start()
_runner = None
_session_service = None


async def _maybe_await(value):
    return await value if inspect.isawaitable(value) else value


async def _chat(session_id: str, message: str) -> dict:
    global _runner, _session_service
    from google.adk.runners import Runner
    from google.adk.sessions import InMemorySessionService
    from google.genai import types

    if _runner is None:
        _session_service = InMemorySessionService()
        _runner = Runner(agent=root_agent, app_name=APP_NAME, session_service=_session_service)

    session = await _maybe_await(
        _session_service.get_session(app_name=APP_NAME, user_id=USER_ID, session_id=session_id))
    if session is None:
        await _maybe_await(
            _session_service.create_session(app_name=APP_NAME, user_id=USER_ID, session_id=session_id))

    content = types.Content(role="user", parts=[types.Part(text=message)])
    tools, final_text, all_text = [], [], []

    async for event in _runner.run_async(user_id=USER_ID, session_id=session_id, new_message=content):
        for call in (event.get_function_calls() if hasattr(event, "get_function_calls") else []) or []:
            tools.append({"name": call.name, "args": dict(call.args or {})})
        parts = event.content.parts if event.content and event.content.parts else []
        texts = [p.text for p in parts if getattr(p, "text", None) and not getattr(p, "thought", False)]
        all_text.extend(texts)
        if texts and event.is_final_response():
            final_text.extend(texts)

    reply = "\n".join(final_text or all_text).strip() or "I could not produce an answer. Please try again."
    return {"reply": reply, "tools": tools}


def _friendly_error(err: Exception) -> str:
    text = str(err)
    if "429" in text or "RESOURCE_EXHAUSTED" in text:
        return ("The free Gemini quota for **" + MODEL + "** is used up for today. "
                "Set another model in `reorder_agent/.env`, e.g. `GEMINI_MODEL=gemini-3.8-flash`, "
                "and restart. The dashboard data above still works without AI.")
    if "503" in text or "UNAVAILABLE" in text or "504" in text:
        return "Gemini is very busy right now. Wait a few seconds and send your message again."
    if "API key" in text or "API_KEY" in text or "401" in text or "403" in text:
        return "The Gemini API key is missing or not valid. Check `GOOGLE_API_KEY` in `reorder_agent/.env`."
    return "The AI assistant hit an error: " + text[:300]


def chat(session_id: str, message: str) -> dict:
    try:
        future = asyncio.run_coroutine_threadsafe(_chat(session_id, message), _loop)
        return future.result(timeout=180)
    except Exception as err:  # noqa: BLE001
        return {"reply": _friendly_error(err), "tools": [], "error": True}


# ---------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # keep the terminal clean
        if "/api/" in (args[0] if args else ""):
            sys.stdout.write("  " + (fmt % args) + "\n")

    def _send(self, code: int, body: bytes, content_type: str):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, data, code: int = 200):
        self._send(code, json.dumps(data).encode("utf-8"), "application/json; charset=utf-8")

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            return {}

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/dashboard":
            return self._json(build_dashboard(force="refresh=1" in self.path))
        if path == "/":
            path = "/index.html"
        file = (WEB_DIR / path.lstrip("/")).resolve()
        if WEB_DIR not in file.parents or not file.is_file():
            return self._send(404, b"Not found", "text/plain")
        ctype = TYPES.get(file.suffix) or mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        return self._send(200, file.read_bytes(), ctype)

    def do_POST(self):
        path = self.path.split("?")[0]
        body = self._body()

        if path == "/api/simulate":
            try:
                result = calculate_risk(
                    int(body["stock"]), int(body["daily_usage"]),
                    int(body["lead_time_days"]), int(body.get("delay", 0)))
                return self._json(result)
            except (KeyError, ValueError, TypeError):
                return self._json({"error": "bad input"}, 400)

        if path == "/api/orders":
            name, action = body.get("name"), body.get("action")
            if name not in {p["name"] for p in INVENTORY} or action not in ("approve", "reject", "reset"):
                return self._json({"error": "bad input"}, 400)
            with _orders_lock:
                if action == "reset":
                    _orders.pop(name, None)
                else:
                    _orders[name] = {
                        "status": "approved" if action == "approve" else "rejected",
                        "at": datetime.now().strftime("%H:%M"),
                    }
            return self._json({"ok": True})

        if path == "/api/chat":
            message = (body.get("message") or "").strip()
            if not message:
                return self._json({"error": "empty message"}, 400)
            return self._json(chat(body.get("session_id") or uuid.uuid4().hex, message))

        return self._json({"error": "not found"}, 404)


def main():
    port = int(os.getenv("PORT", "8080"))
    for candidate in range(port, port + 10):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", candidate), Handler)
            break
        except OSError:
            continue
    else:
        sys.exit("No free port found between %d and %d." % (port, port + 9))

    url = "http://127.0.0.1:%d" % server.server_address[1]
    print("")
    print("  ReorderAI dashboard is running")
    print("  Open: " + url)
    print("  AI model: " + MODEL + ("" if os.getenv("GOOGLE_API_KEY") else "  (no API key found)"))
    print("  Press Ctrl+C to stop")
    print("")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")


if __name__ == "__main__":
    main()
