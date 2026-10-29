# Dream Data – ReorderAI

> An AI agent that helps businesses avoid stock shortages before they happen.

Built for **JOB191 – Dream Data Labs Solutions: AI Augmented Software Engineering** (İstinye University).

---

## The Problem

Small and mid-size businesses often discover stock shortages too late. Delayed shipments, bad weather and price swings are tracked manually, if at all, so purchase orders go out late and the business loses sales or overpays for rush orders.

## The Solution

ReorderAI is an AI agent that:

1. **Monitors** external risk signals (currently: live weather at supplier locations)
2. **Compares** them with current inventory
3. **Predicts** which products are likely to run out
4. **Drafts risk-scored purchase orders** for a human to approve

The agent never places orders on its own. Every purchase order is marked **AWAITING HUMAN APPROVAL**.

---

## Current Status (Sprint 0 demo)

| Feature | Status |
|---|---|
| Inventory data (sample products) | ✅ Done (in-memory) |
| Live weather risk tool (Open-Meteo API) | ✅ Done |
| Stock-out risk calculation (HIGH / MEDIUM / LOW) | ✅ Done |
| Monitor agent built with Google ADK + Gemini | ✅ Done |
| Draft purchase orders with human approval status | ✅ Done |
| Chat interface (ADK Dev UI) | ✅ Done |
| Fallback demo script (no LLM needed) | ✅ Done |
| Forecast agent (demand forecasting) | ⏳ Planned |
| Procurement agent + PO approval workflow | ⏳ Planned |
| News, FX and commodity price tools | ⏳ Planned |
| PostgreSQL (Cloud SQL) + SQLAlchemy | ⏳ Planned |
| Streamlit dashboard + FastAPI backend | ⏳ Planned |
| Deployment on Google Cloud Run | ⏳ Planned |

---

## How It Works

```
                 ┌───────────────────────────┐
  User  ──────▶  │  reorder_monitor_agent    │  (Gemini via Google ADK)
                 └─────────────┬─────────────┘
                               │ calls tools
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
   get_inventory()     get_weather_risk(city)   calculate_risk(...)
   product stock,      7-day forecast →         days of stock left vs.
   usage, supplier     expected delay days      lead time + delay →
                                                risk level + order qty
                               │
                               ▼
              Risk table + draft purchase orders
              (STATUS: AWAITING HUMAN APPROVAL)
```

**Risk rule:**

- `days_left = stock / daily_usage`
- `arrival_days = lead_time_days + weather_delay_days`
- **HIGH** if `days_left < arrival_days`
- **MEDIUM** if `days_left < arrival_days + 3`
- **LOW** otherwise

**Weather delay rule:** rain > 20 mm or wind > 50 km/h → +3 days; rain > 10 mm or wind > 35 km/h → +1 day.

The math runs in Python, not in the LLM, so the numbers are always correct. Gemini decides which tools to call and writes the final report.

---

## Tech Stack

- **Python 3.10+**
- **Google ADK** (Agent Development Kit)
- **Gemini** (`gemini-3.6-flash`)
- **Open-Meteo API** (free weather + geocoding, no key needed)
- Planned: FastAPI, Streamlit, PostgreSQL (Cloud SQL), SQLAlchemy, Cloud Run, Secret Manager, Cloud Scheduler, GitHub Actions

---

## Project Structure

```
dream-data-reorderai/
├── reorder_agent/
│   ├── __init__.py        # makes the agent loadable by ADK
│   ├── agent.py           # inventory, tools and the agent
│   └── .env               # your API key (NOT committed)
├── demo.py                # fallback demo: runs the tools without Gemini
├── .env.example           # template for the .env file
├── requirements.txt
├── .gitignore
└── README.md
```

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/mohamad-abdullah-710/dream-data-reorderai.git
cd dream-data-reorderai
```

### 2. Create a virtual environment

**Windows**
```bash
python -m venv venv
venv\Scripts\activate
```

**macOS / Linux**
```bash
python3 -m venv venv
source venv/bin/activate
```

### 3. Install dependencies

```bash
python -m pip install -r requirements.txt
```

### 4. Add your Gemini API key

Get a free key at [Google AI Studio](https://aistudio.google.com/api-keys).

Copy `.env.example` into `reorder_agent/.env` and paste your key:

```
GOOGLE_GENAI_USE_VERTEXAI=FALSE
GOOGLE_API_KEY=your_api_key_here
```

⚠️ Never commit your `.env` file. It is already listed in `.gitignore`.

---

## Running

### Option A: Agent chat UI (main demo)

From the project root folder:

```bash
python -m google.adk.cli web
```

1. Open **http://127.0.0.1:8000**
2. Select **reorder_agent** at the top left
3. Send: `Check my stock risks and draft purchase orders.`

The UI shows each tool call and the final risk table with draft purchase orders.

### Option B: Fallback demo (no Gemini needed)

```bash
python demo.py
```

Runs the same tools directly (live weather included) and prints the risk report and draft purchase orders in the terminal.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `pip.exe was blocked` (Windows policy) | Use `python -m pip ...` instead of `pip ...` |
| `adk` command blocked | Use `python -m google.adk.cli web` instead of `adk web` |
| `404 NOT_FOUND ... model is no longer available` | Change `model=` in `agent.py` to a current model from AI Studio |
| `503 UNAVAILABLE ... high demand` | Gemini is busy. Wait a bit, then send `Continue` in the same session, or switch to another flash model |
| Chat keeps loading forever after restarting the server | Close the old tab and open http://127.0.0.1:8000 again (sessions reset on restart) |

---

## Roadmap

- **Sprint 1:** Move inventory to PostgreSQL (Cloud SQL) with SQLAlchemy; add news and FX tools
- **Sprint 2:** Forecast agent for demand forecasting
- **Sprint 3:** Procurement agent and PO approval workflow (approve / reject)
- **Sprint 4:** Streamlit dashboard, FastAPI backend, deploy on Cloud Run with Secret Manager and Cloud Scheduler, CI with GitHub Actions

---

## Team

Dream Data Labs – JOB191, İstinye University

- Mohamad Abdullah Abd
