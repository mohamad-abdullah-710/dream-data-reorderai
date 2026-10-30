/* ReorderAI dashboard */
const HOME = { name: "Your warehouse", city: "Istanbul", lat: 41.01, lon: 28.98 };
const RISK_COLOR = { HIGH: "#ff5d5d", MEDIUM: "#ffb547", LOW: "#34d399" };
const RISK_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const state = { data: null, map: null, mapLayer: null, sessionId: newSessionId() };
const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function newSessionId() {
  try {
    const saved = sessionStorage.getItem("reorderai-session");
    if (saved) return saved;
    const id = "s" + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem("reorderai-session", id);
    return id;
  } catch (e) {
    return "s" + Math.random().toString(36).slice(2, 10);
  }
}

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  if (!res.ok) throw new Error("Request failed: " + res.status);
  return res.json();
}

function toast(text) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.innerHTML = icon("check") + esc(text);
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2400);
}

/* ---------------- weather helpers ---------------- */
function wxIcon(code) {
  if (code == null) return "cloud";
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "cloudRain";
  if (code === 3 || code === 45 || code === 48) return "cloud";
  if (code === 1 || code === 2) return "cloudSun";
  return "sun";
}

function worstCode(forecast) {
  return forecast && forecast.length ? Math.max(...forecast.map((d) => d.code ?? 0)) : null;
}

function delayOf(p) {
  return p.weather_ok ? p.weather.expected_delay_days : 0;
}

/* ---------------- load + render ---------------- */
async function load(force = false) {
  const btn = $("refreshBtn");
  btn.classList.add("spin");
  try {
    state.data = await api("/api/dashboard" + (force ? "?refresh=1" : ""));
    render();
    if (force) toast("Live data refreshed");
  } catch (e) {
    $("updated").textContent = "Server not reachable";
  } finally {
    btn.classList.remove("spin");
  }
}

function render() {
  const d = state.data;
  const products = [...d.products].sort(
    (a, b) => RISK_ORDER[a.risk.risk_level] - RISK_ORDER[b.risk.risk_level] || a.risk.days_of_stock_left - b.risk.days_of_stock_left);

  const time = new Date(d.generated_at);
  $("updated").textContent = "Updated " + time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  $("modelChip").lastChild.textContent = d.ai_ready ? "AI · " + d.model : "AI · no API key";
  $("drawerModel").textContent = "Gemini agent (" + d.model + ") · uses the same tools";

  renderKPIs(products);
  renderMap(products);
  renderAlerts(products);
  renderTable(products);
  renderOrders(products);
  renderSimulatorOptions(products);
}

function renderKPIs(products) {
  const high = products.filter((p) => p.risk.risk_level === "HIGH");
  const medium = products.filter((p) => p.risk.risk_level === "MEDIUM");
  const next = products.reduce((a, b) => (b.risk.days_of_stock_left < a.risk.days_of_stock_left ? b : a));
  const pending = products.filter((p) => p.order_status === "pending");
  const approved = products.filter((p) => p.order_status === "approved");
  const pendingValue = pending.reduce((s, p) => s + p.order_value, 0);
  const approvedValue = approved.reduce((s, p) => s + p.order_value, 0);

  const cards = [
    { cls: "", ic: "package", label: "Products monitored", value: products.length,
      sub: products.length + " suppliers · " + new Set(products.map((p) => p.supplier_city)).size + " cities" },
    { cls: "high", ic: "alert", label: "High risk", value: high.length,
      sub: high.length ? high.map((p) => p.name).join(", ") : "Nothing critical", },
    { cls: "medium", ic: "clock", label: "Next stock-out", value: next.risk.days_of_stock_left, unit: "days",
      sub: next.name },
    { cls: "violet", ic: "coins", label: "Awaiting your approval", value: money.format(pendingValue),
      sub: pending.length + " draft orders" + (approved.length ? " · " + money.format(approvedValue) + " approved" : "") },
  ];

  $("kpis").innerHTML = cards.map((c, i) => `
    <div class="card kpi ${c.cls} fade-in" style="animation-delay:${i * 60}ms">
      <div class="k-icon">${icon(c.ic)}</div>
      <div class="k-label">${esc(c.label)}</div>
      <div class="k-value">${esc(c.value)}${c.unit ? `<small>${esc(c.unit)}</small>` : ""}</div>
      <div class="k-sub">${esc(c.sub)}</div>
    </div>`).join("");
}

/* ---------------- map ---------------- */
function curve(a, b, steps = 40) {
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const dx = b[1] - a[1], dy = b[0] - a[0];
  const ctrl = [mid[0] + dx * 0.18, mid[1] - dy * 0.18];
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push([
      (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * ctrl[0] + t ** 2 * b[0],
      (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * ctrl[1] + t ** 2 * b[1],
    ]);
  }
  return pts;
}

function popupHtml(p) {
  const r = p.risk;
  const wx = p.weather_ok
    ? `${p.weather.max_rain_mm} mm rain · ${p.weather.max_wind_kmh} km/h wind`
    : "Weather unavailable";
  return `<div class="pop-title">${esc(p.supplier)}</div>
    <div class="pop-sub">${esc(p.supplier_city)} · supplies ${esc(p.name)}</div>
    <div style="margin-top:8px"><span class="badge ${r.risk_level}">${r.risk_level}</span></div>
    <div style="margin-top:8px">${r.days_of_stock_left} days of stock · arrives in ${r.days_until_new_order_arrives} days</div>
    <div class="pop-sub">${esc(wx)}</div>`;
}

function renderMap(products) {
  if (window.L) return renderLeaflet(products);
  renderSvgMap(products);
}

function renderLeaflet(products) {
  if (!state.map) {
    state.map = L.map("map", { zoomControl: false, worldCopyJump: true, attributionControl: true, scrollWheelZoom: false });
    L.control.zoom({ position: "bottomright" }).addTo(state.map);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 8, subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    }).addTo(state.map);
    state.mapLayer = L.layerGroup().addTo(state.map);
  }
  const layer = state.mapLayer;
  layer.clearLayers();
  const home = [HOME.lat, HOME.lon];

  products.forEach((p) => {
    const color = RISK_COLOR[p.risk.risk_level];
    L.polyline(curve([p.lat, p.lon], home), { color, weight: 2, opacity: 0.75, className: "lane" }).addTo(layer);
    const ring = p.risk.risk_level === "LOW" ? "" : "<i></i>";
    L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className: "", html: `<div class="pin" style="color:${color};width:16px;height:16px">${ring}<b></b></div>`, iconSize: [16, 16] }),
    }).bindPopup(popupHtml(p)).bindTooltip(esc(p.supplier_city), { direction: "top", offset: [0, -10] }).addTo(layer);
  });

  L.marker(home, {
    icon: L.divIcon({ className: "", html: `<div class="pin home" style="width:18px;height:18px"><i></i><b></b></div>`, iconSize: [18, 18] }),
  }).bindPopup(`<div class="pop-title">${HOME.name}</div><div class="pop-sub">${HOME.city} · all orders ship here</div>`).addTo(layer);

  const bounds = L.latLngBounds(products.map((p) => [p.lat, p.lon]).concat([home]));
  state.map.fitBounds(bounds.pad(0.18));
  setTimeout(() => state.map.invalidateSize(), 200);
}

/* Offline fallback: simple world grid with supplier routes (no map tiles needed). */
function renderSvgMap(products) {
  const W = 800, H = 380;
  const lats = products.map((p) => p.lat).concat(HOME.lat), lons = products.map((p) => p.lon).concat(HOME.lon);
  const pad = 14;
  const lon0 = Math.min(...lons) - pad, lon1 = Math.max(...lons) + pad;
  const lat0 = Math.min(...lats) - pad, lat1 = Math.max(...lats) + pad;
  const proj = (lat, lon) => [((lon - lon0) / (lon1 - lon0)) * W, ((lat1 - lat) / (lat1 - lat0)) * H];
  let grid = "";
  for (let lon = -180; lon <= 180; lon += 15) { const [x] = proj(0, lon); grid += `<line x1="${x}" y1="0" x2="${x}" y2="${H}"/>`; }
  for (let lat = -75; lat <= 75; lat += 15) { const [, y] = proj(lat, 0); grid += `<line x1="0" y1="${y}" x2="${W}" y2="${y}"/>`; }
  const [hx, hy] = proj(HOME.lat, HOME.lon);
  const items = products.map((p) => {
    const [x, y] = proj(p.lat, p.lon);
    const cx = (x + hx) / 2, cy = Math.min(y, hy) - 50;
    const c = RISK_COLOR[p.risk.risk_level];
    return `<path class="lane" d="M${x},${y} Q${cx},${cy} ${hx},${hy}" stroke="${c}" stroke-width="2" fill="none" opacity="0.8"/>
      <circle cx="${x}" cy="${y}" r="7" fill="${c}" stroke="#fff" stroke-width="2"/>
      <text x="${x > W - 110 ? x - 11 : x + 11}" y="${y + 4}" text-anchor="${x > W - 110 ? "end" : "start"}" fill="#e7eef8" font-size="12">${esc(p.supplier_city)}</text>`;
  }).join("");
  $("map").innerHTML = `<svg class="map-fallback" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    <g stroke="rgba(148,163,184,0.12)">${grid}</g>${items}
    <circle cx="${hx}" cy="${hy}" r="8" fill="#5eead4" stroke="#fff" stroke-width="2"/>
    <text x="${hx + 12}" y="${hy - 8}" fill="#5eead4" font-size="12" font-weight="600">${HOME.city} (warehouse)</text></svg>`;
}

/* ---------------- alerts ---------------- */
function renderAlerts(products) {
  const items = [];
  products.forEach((p) => {
    const r = p.risk;
    if (r.risk_level === "HIGH") {
      items.push({ cls: "high", ic: "alert", title: `${p.name} runs out in ${r.days_of_stock_left} days`,
        text: `A new order needs ${r.days_until_new_order_arrives} days to arrive. Reorder ${r.suggested_order_quantity} units now.` });
    } else if (r.risk_level === "MEDIUM") {
      items.push({ cls: "medium", ic: "clock", title: `${p.name} is getting close`,
        text: `${r.days_of_stock_left} days of stock vs ${r.days_until_new_order_arrives} days delivery. Order soon.` });
    }
  });
  products.forEach((p) => {
    if (!p.weather_ok) {
      items.push({ cls: "weather", ic: "cloud", title: `No weather data for ${p.supplier_city}`, text: "Assuming no extra delay for now." });
    } else if (p.weather.expected_delay_days > 0) {
      items.push({ cls: "weather", ic: wxIcon(worstCode(p.forecast)) === "storm" ? "storm" : "cloudRain",
        title: `Bad weather near ${p.supplier_city}`,
        text: `Up to ${p.weather.max_rain_mm} mm rain and ${p.weather.max_wind_kmh} km/h wind → +${p.weather.expected_delay_days} day${p.weather.expected_delay_days > 1 ? "s" : ""} shipping delay.` });
    }
  });
  const risky = products.filter((p) => p.risk.risk_level !== "LOW").length;
  if (!risky) items.push({ cls: "ok", ic: "shield", title: "All clear", text: "Every product has enough stock for its next delivery." });

  $("alertCount").textContent = risky + " at risk";
  $("alerts").innerHTML = items.map((a, i) => `
    <li class="alert ${a.cls} fade-in" style="animation-delay:${i * 50}ms">
      <div class="a-icon">${icon(a.ic)}</div>
      <div><b>${esc(a.title)}</b><p>${esc(a.text)}</p></div>
    </li>`).join("");
}

/* ---------------- inventory table ---------------- */
function renderTable(products) {
  const maxDays = Math.min(30, Math.max(...products.map((p) => Math.max(p.risk.days_of_stock_left, p.risk.days_until_new_order_arrives))) * 1.1);

  $("invBody").innerHTML = products.map((p, i) => {
    const r = p.risk;
    const color = RISK_COLOR[r.risk_level];
    const fill = Math.min(r.days_of_stock_left / maxDays, 1) * 100;
    const mark = Math.min(r.days_until_new_order_arrives / maxDays, 1) * 100;
    const fc = p.forecast || [];
    const maxRain = Math.max(15, ...fc.map((d) => d.rain || 0));
    const spark = fc.map((d) => `<i class="${(d.rain || 0) > 5 ? "wet" : ""}" style="height:${Math.max(8, ((d.rain || 0) / maxRain) * 100)}%" title="${esc(d.date)}: ${d.rain} mm, ${d.wind} km/h"></i>`).join("");
    const wxText = p.weather_ok
      ? `${p.weather.max_rain_mm} mm · ${p.weather.max_wind_kmh} km/h<br>${delayOf(p) ? `<span style="color:var(--medium)">+${delayOf(p)} day delay</span>` : "no delay"}`
      : "unavailable";
    return `<tr class="fade-in" style="animation-delay:${i * 50}ms">
      <td><div class="prod"><div class="p-icon">${icon(p.category)}</div><div><b>${esc(p.name)}</b><small>${money.format(p.unit_cost)} / unit</small></div></div></td>
      <td><div class="sup"><span>${esc(p.supplier)}</span><small data-icon="pin">${esc(p.supplier_city)}</small></div></td>
      <td class="num">${p.stock}</td>
      <td class="num">${p.daily_usage}</td>
      <td>
        <div class="runway"><div class="fill" style="width:${fill}%;background:${color}"></div><div class="mark" style="left:${mark}%"></div></div>
        <div class="runway-label"><span>${r.days_of_stock_left} d left</span><span>arrives in ${r.days_until_new_order_arrives} d</span></div>
      </td>
      <td><div class="wx"><span class="wx-icon">${icon(wxIcon(worstCode(fc)))}</span>${spark ? `<div class="spark">${spark}</div>` : ""}<div class="wx-text">${wxText}</div></div></td>
      <td><span class="badge ${r.risk_level}"><span class="dot bg-${r.risk_level.toLowerCase()}"></span>${r.risk_level}</span></td>
    </tr>`;
  }).join("");
  hydrateIcons($("invBody"));
}

/* ---------------- purchase orders ---------------- */
function poId(p, i) {
  const d = new Date();
  return `PO-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`;
}

function renderOrders(products) {
  const list = products.filter((p) => p.order_status !== "none");
  if (!list.length) {
    $("orders").innerHTML = `<div class="empty">${icon("shield")} No orders needed right now.</div>`;
    return;
  }
  $("orders").innerHTML = list.map((p, i) => {
    const r = p.risk;
    const status = p.order_status;
    const actions = status === "pending"
      ? `<button class="btn approve" data-act="approve" data-name="${esc(p.name)}">${icon("check")}Approve</button>
         <button class="btn reject" data-act="reject" data-name="${esc(p.name)}">${icon("x")}Reject</button>
         <span class="status pending">${icon("clock")}Awaiting approval</span>`
      : `<span class="status ${status}">${icon(status === "approved" ? "check" : "x")}${status === "approved" ? "Approved" : "Rejected"} at ${esc(p.order_decided_at)}</span>
         ${status === "approved" ? `<button class="link" data-act="download" data-name="${esc(p.name)}" data-id="${poId(p, i)}">${icon("package")}Download PO</button>` : ""}
         <button class="link" data-act="reset" data-name="${esc(p.name)}">${icon("undo")}Undo</button>`;
    return `<div class="po ${status} fade-in" style="animation-delay:${i * 60}ms">
      <div class="po-top">
        <div class="prod"><div class="p-icon">${icon(p.category)}</div><div><b>${esc(p.name)}</b><span class="po-id">${poId(p, i)} · ${esc(p.supplier)}</span></div></div>
        <span class="badge ${r.risk_level}">${r.risk_level}</span>
      </div>
      <div class="po-grid">
        <div><small>Quantity</small><b>${r.suggested_order_quantity}</b></div>
        <div><small>Est. cost</small><b>${money.format(p.order_value)}</b></div>
        <div><small>Ship from</small><b>${esc(p.supplier_city)}</b></div>
        <div><small>Arrives in</small><b>${r.days_until_new_order_arrives} d</b></div>
      </div>
      <p class="po-reason">Only ${r.days_of_stock_left} days of stock left, but delivery takes ${p.lead_time_days} days${delayOf(p) ? ` + ${delayOf(p)} day weather delay` : ""}. Quantity covers delivery time plus 14 days of buffer.</p>
      <div class="po-actions">${actions}</div>
    </div>`;
  }).join("");
}

function downloadPo(name, id) {
  const p = state.data.products.find((x) => x.name === name);
  const r = p.risk;
  const text = [
    "PURCHASE ORDER " + id, "Generated by ReorderAI · approved by a human", "",
    "Supplier:   " + p.supplier + " (" + p.supplier_city + ")",
    "Ship to:    " + HOME.name + ", " + HOME.city,
    "Product:    " + p.name,
    "Quantity:   " + r.suggested_order_quantity + " units",
    "Unit cost:  " + money.format(p.unit_cost),
    "Total:      " + money.format(p.order_value),
    "Risk:       " + r.risk_level + " (" + r.days_of_stock_left + " days of stock left)",
    "Approved:   " + p.order_decided_at,
  ].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = id + ".txt";
  a.click();
  URL.revokeObjectURL(a.href);
}

$("orders").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const { act, name } = btn.dataset;
  if (act === "download") return downloadPo(name, btn.dataset.id);
  btn.disabled = true;
  await api("/api/orders", { name, action: act });
  await load(false);
  toast(act === "approve" ? `Order for ${name} approved` : act === "reject" ? `Order for ${name} rejected` : "Decision undone");
});

/* ---------------- what-if simulator ---------------- */
let simTimer;
function renderSimulatorOptions(products) {
  const sel = $("simProduct");
  const current = sel.value;
  sel.innerHTML = products.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join("");
  sel.value = current && products.some((p) => p.name === current) ? current : products[0].name;
  if (!current) resetSimulator();
}

function resetSimulator() {
  const p = state.data.products.find((x) => x.name === $("simProduct").value);
  $("simStock").max = Math.max(600, p.stock * 2);
  $("simStock").value = p.stock;
  $("simUse").value = p.daily_usage;
  $("simDelay").value = delayOf(p);
  runSimulator();
}

function runSimulator() {
  const p = state.data.products.find((x) => x.name === $("simProduct").value);
  const stock = +$("simStock").value, use = +$("simUse").value, delay = +$("simDelay").value;
  $("simStockOut").textContent = stock + " units";
  $("simUseOut").textContent = use + " / day";
  $("simDelayOut").textContent = "+" + delay + (delay === 1 ? " day" : " days");
  clearTimeout(simTimer);
  simTimer = setTimeout(async () => {
    const r = await api("/api/simulate", { stock, daily_usage: use, lead_time_days: p.lead_time_days, delay });
    const color = RISK_COLOR[r.risk_level];
    const ratio = Math.min(r.days_of_stock_left / (r.days_until_new_order_arrives + 3), 1);
    const C = 2 * Math.PI * 52;
    $("simResult").innerHTML = `
      <div class="gauge">
        <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" stroke="rgba(255,255,255,0.08)" stroke-width="10" fill="none"/>
        <circle cx="60" cy="60" r="52" stroke="${color}" stroke-width="10" fill="none" stroke-linecap="round"
          stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - ratio)}" style="transition:stroke-dashoffset .5s, stroke .3s"/></svg>
        <div class="g-text"><div><b>${r.days_of_stock_left}</b><small>days left</small></div></div>
      </div>
      <div class="sim-facts">
        <div><span class="badge ${r.risk_level}">${r.risk_level} RISK</span></div>
        <p>New order arrives in <b>${r.days_until_new_order_arrives} days</b></p>
        <p>Suggested order <b>${r.suggested_order_quantity} units</b> (~${money.format(r.suggested_order_quantity * p.unit_cost)})</p>
        <p>${r.risk_level === "HIGH" ? "Stock runs out before the order can arrive." : r.risk_level === "MEDIUM" ? "Tight: less than 3 days of safety margin." : "Safe: enough stock for the next delivery."}</p>
      </div>`;
  }, 120);
}

$("simProduct").addEventListener("change", resetSimulator);
["simStock", "simUse", "simDelay"].forEach((id) => $(id).addEventListener("input", runSimulator));

/* ---------------- AI assistant ---------------- */
function openDrawer(open = true) {
  $("drawer").classList.toggle("open", open);
  $("drawer").setAttribute("aria-hidden", String(!open));
  $("scrim").classList.toggle("show", open);
  if (open) setTimeout(() => $("chatInput").focus(), 250);
}

function inline(text) {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
}

/* Tiny markdown renderer: headings, lists, tables, bold, code. */
function markdown(src) {
  const lines = esc(src).split(/\r?\n/);
  let html = "", i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      const [head, ...rest] = body;
      html += "<table><thead><tr>" + cells(head).map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>" +
        rest.map((r) => "<tr>" + cells(r).map((c) => `<td>${c}</td>`).join("") + "</tr>").join("") + "</tbody></table>";
      continue;
    }
    if (/^\s*([-*•]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*•]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+\.)\s+/, ""));
      html += (ordered ? "<ol>" : "<ul>") + items.map((t) => `<li>${inline(t)}</li>`).join("") + (ordered ? "</ol>" : "</ul>");
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { html += `<h4>${inline(h[2])}</h4>`; i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { html += "<hr style='border:none;border-top:1px solid var(--border)'>"; i++; continue; }
    if (line.trim()) html += `<p>${inline(line)}</p>`;
    i++;
  }
  return html;
}

function addMessage(cls, html) {
  const el = document.createElement("div");
  el.className = "msg " + cls + " fade-in";
  el.innerHTML = html;
  $("messages").appendChild(el);
  $("messages").scrollTop = $("messages").scrollHeight;
  return el;
}

function toolLabel(t) {
  const args = Object.values(t.args || {});
  const shown = args.length && args.length <= 2 ? args.map((a) => JSON.stringify(a)).join(", ") : args.length ? "…" : "";
  return `${t.name}(${shown})`;
}

async function sendChat(text) {
  text = text.trim();
  if (!text) return;
  $("suggestions").style.display = "none";
  addMessage("user", esc(text));
  $("chatInput").value = "";
  $("composer").querySelector("button").disabled = true;
  const typing = addMessage("bot", `<div class="typing"><i></i><i></i><i></i><span>Checking inventory, weather and risk…</span></div>`);
  try {
    const res = await api("/api/chat", { message: text, session_id: state.sessionId });
    const tools = (res.tools || []).length
      ? `<div class="tools">${res.tools.map((t) => `<span class="tool-chip">${icon("tool")}${esc(toolLabel(t))}</span>`).join("")}</div>` : "";
    typing.innerHTML = tools + markdown(res.reply);
    if (res.error) typing.classList.add("error");
  } catch (e) {
    typing.innerHTML = "Could not reach the server. Is <code>python app.py</code> still running?";
    typing.classList.add("error");
  } finally {
    $("composer").querySelector("button").disabled = false;
    $("messages").scrollTop = $("messages").scrollHeight;
  }
}

$("askBtn").addEventListener("click", () => openDrawer(true));
$("fab").addEventListener("click", () => openDrawer(true));
$("closeDrawer").addEventListener("click", () => openDrawer(false));
$("scrim").addEventListener("click", () => openDrawer(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") openDrawer(false); });
$("suggestions").addEventListener("click", (e) => { if (e.target.tagName === "BUTTON") sendChat(e.target.textContent); });
$("composer").addEventListener("submit", (e) => { e.preventDefault(); sendChat($("chatInput").value); });
$("refreshBtn").addEventListener("click", () => load(true));

hydrateIcons();
load();
