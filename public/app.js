const STORAGE_KEY = "investmentTracker.holdings";

const TYPE_COLOR_HEX = {
  "Acción": { light: "#2a78d6", dark: "#3987e5" },
  "ETF": { light: "#eb6834", dark: "#d95926" },
  "Fondo": { light: "#1baf7a", dark: "#199e70" },
};

const TIPO_ACTIVO_MAP = {
  fondo: "Fondo",
  accion: "Acción",
  acción: "Acción",
  etf: "ETF",
};

function loadHoldings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveHoldings(holdings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(holdings));
}

function fmtMoney(n, currency = "EUR") {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("es-ES", { style: "currency", currency, maximumFractionDigits: 2 });
}

function fmtPct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function isDarkMode() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

let holdings = loadHoldings();
let fxRate = null; // USD por 1 EUR (par EURUSD=X)

function toEUR(amountNative, currency) {
  if (currency === "EUR" || amountNative == null) return amountNative;
  if (!fxRate) return amountNative; // sin tasa disponible, se muestra sin convertir
  return amountNative / fxRate;
}

function computeRow(h) {
  const currency = h.currency || "USD";
  const price = h.lastPrice ?? h.avgCostNative ?? h.buyPrice;
  const avgCostNative = h.avgCostNative ?? h.buyPrice;
  const marketValueNative = h.quantity * price;
  const marketValueEUR = toEUR(marketValueNative, currency);
  const costEUR = h.costEUR != null ? h.costEUR : toEUR(h.quantity * avgCostNative, currency);
  const gainEUR = marketValueEUR - costEUR;
  const gainPct = costEUR > 0 ? (gainEUR / costEUR) * 100 : 0;
  return { ...h, currency, price, avgCostNative, marketValueNative, marketValueEUR, costEUR, gainEUR, gainPct };
}

function renderTiles(rows) {
  const invested = rows.reduce((s, r) => s + r.costEUR, 0);
  const current = rows.reduce((s, r) => s + r.marketValueEUR, 0);
  const gain = current - invested;
  const gainPct = invested > 0 ? (gain / invested) * 100 : 0;

  document.getElementById("tile-invested").textContent = fmtMoney(invested);
  document.getElementById("tile-current").textContent = fmtMoney(current);

  const gainEl = document.getElementById("tile-gain");
  gainEl.textContent = (gain >= 0 ? "▲ " : "▼ ") + fmtMoney(Math.abs(gain));
  gainEl.className = "value " + (gain >= 0 ? "good" : "bad");

  const pctEl = document.getElementById("tile-pct");
  pctEl.textContent = fmtPct(gainPct);
  pctEl.className = "value " + (gainPct >= 0 ? "good" : "bad");
}

function renderTable(rows) {
  const body = document.getElementById("holdings-body");
  const emptyState = document.getElementById("empty-state");
  body.innerHTML = "";

  emptyState.hidden = rows.length > 0;

  rows.forEach((r) => {
    const tr = document.createElement("tr");
    const warn = r.quoteError ? ` title="No se pudo actualizar el precio: ${r.quoteError}"` : "";
    tr.innerHTML = `
      <td class="symbol"${warn}>${r.symbol}${r.quoteError ? " ⚠" : ""}</td>
      <td>${r.type}</td>
      <td>${r.quantity}</td>
      <td>${fmtMoney(r.avgCostNative, r.currency)}</td>
      <td>${fmtMoney(r.costEUR)}</td>
      <td>${fmtMoney(r.price, r.currency)}</td>
      <td>${fmtMoney(r.marketValueEUR)}</td>
      <td class="gain ${r.gainEUR >= 0 ? "good" : "bad"}">${r.gainEUR >= 0 ? "▲" : "▼"} ${fmtMoney(Math.abs(r.gainEUR))} (${fmtPct(r.gainPct)})</td>
      <td class="remove"><button title="Eliminar" data-id="${r.id}">✕</button></td>
    `;
    body.appendChild(tr);
  });

  body.querySelectorAll("button[data-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      holdings = holdings.filter((h) => h.id !== btn.dataset.id);
      saveHoldings(holdings);
      render();
    });
  });
}

function renderDonut(rows) {
  const byType = {};
  rows.forEach((r) => {
    byType[r.type] = (byType[r.type] || 0) + r.marketValueEUR;
  });
  const total = Object.values(byType).reduce((a, b) => a + b, 0);
  const dark = isDarkMode();

  const svg = document.getElementById("donut");
  const legend = document.getElementById("legend");
  svg.innerHTML = "";
  legend.innerHTML = "";

  if (total <= 0) {
    svg.innerHTML = `<circle cx="100" cy="100" r="70" fill="none" stroke="var(--gridline)" stroke-width="24"/>`;
    legend.innerHTML = `<div class="legend-item"><span class="legend-label">Sin datos todav&iacute;a</span></div>`;
    return;
  }

  const order = ["Acción", "ETF", "Fondo"];
  const r = 70;
  const circumference = 2 * Math.PI * r;
  let offset = 0;

  order.forEach((type) => {
    const val = byType[type];
    if (!val) return;
    const frac = val / total;
    const dash = frac * circumference;
    const color = TYPE_COLOR_HEX[type][dark ? "dark" : "light"];

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "100");
    circle.setAttribute("cy", "100");
    circle.setAttribute("r", String(r));
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", color);
    circle.setAttribute("stroke-width", "24");
    circle.setAttribute("stroke-dasharray", `${dash} ${circumference - dash}`);
    circle.setAttribute("stroke-dashoffset", String(-offset));
    circle.setAttribute("transform", "rotate(-90 100 100)");

    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${type}: ${fmtMoney(val)} (${(frac * 100).toFixed(1)}%)`;
    circle.appendChild(title);

    svg.appendChild(circle);
    offset += dash;

    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `
      <span class="legend-swatch" style="background:${color}"></span>
      <span class="legend-label">${type}</span>
      <span class="legend-value">${(frac * 100).toFixed(1)}%</span>
    `;
    legend.appendChild(item);
  });
}

function render() {
  const rows = holdings.map(computeRow);
  renderTiles(rows);
  renderTable(rows);
  renderDonut(rows);
}

async function refreshPrices() {
  if (holdings.length === 0) return;
  const btn = document.getElementById("refresh-btn");
  btn.disabled = true;
  btn.textContent = "Actualizando…";

  const symbols = [...new Set(holdings.map((h) => h.symbol))];
  symbols.push("EURUSD=X");

  try {
    const res = await fetch(`/api/quotes?symbols=${encodeURIComponent(symbols.join(","))}`);
    const quotes = await res.json();
    const bySymbol = Object.fromEntries(quotes.map((q) => [q.symbol, q]));

    if (bySymbol["EURUSD=X"] && bySymbol["EURUSD=X"].price) {
      fxRate = bySymbol["EURUSD=X"].price;
    }

    // Convierte el precio a la divisa original de la operación si Yahoo resolvió
    // el ticker a un listado en otra divisa (mismo ISIN, distinta plaza/clase).
    function priceInHoldingCurrency(q, holdingCurrency) {
      if (!q.currency || q.currency === holdingCurrency) return q.price;
      if (!fxRate) return null; // no se puede convertir todavía, se reintentará
      if (holdingCurrency === "EUR" && q.currency === "USD") return q.price / fxRate;
      if (holdingCurrency === "USD" && q.currency === "EUR") return q.price * fxRate;
      return null; // par de divisas no soportado
    }

    holdings = holdings.map((h) => {
      const q = bySymbol[h.symbol];
      if (!q) return { ...h, quoteError: "sin respuesta" };
      if (q.price == null) return { ...h, quoteError: q.error };

      const price = priceInHoldingCurrency(q, h.currency || "USD");
      if (price == null) {
        return { ...h, quoteError: `cotización en ${q.currency}, no se pudo convertir a ${h.currency}` };
      }
      return { ...h, lastPrice: price, name: q.name, quoteError: null };
    });
    saveHoldings(holdings);
    document.getElementById("last-updated").textContent =
      "Actualizado: " + new Date().toLocaleTimeString("es-ES");
  } catch (err) {
    document.getElementById("last-updated").textContent = "Error al actualizar precios";
  } finally {
    btn.disabled = false;
    btn.textContent = "Actualizar precios";
    render();
  }
}

document.getElementById("add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.target;
  const symbol = form.symbol.value.trim().toUpperCase();
  if (!symbol) return;

  holdings.push({
    id: crypto.randomUUID(),
    symbol,
    type: form.type.value,
    quantity: parseFloat(form.quantity.value),
    avgCostNative: parseFloat(form.buyPrice.value),
    currency: form.currency.value,
    lastPrice: null,
  });
  saveHoldings(holdings);
  form.reset();
  render();
  refreshPrices();
});

document.getElementById("refresh-btn").addEventListener("click", refreshPrices);

// ---------- Importador de CSV de movimientos ----------

function parseEsNumber(str) {
  if (str === undefined || str === null) return null;
  const s = str.trim();
  if (s === "") return null;
  const normalized = s.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(normalized);
  return Number.isNaN(n) ? null : n;
}

function parseEsDate(str) {
  const [d, m, y] = str.trim().split("/").map(Number);
  if (!d || !m || !y) return new Date(0);
  return new Date(y, m - 1, d);
}

function parseMovementsCsv(text) {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== "");
  const rows = lines.slice(1).map((line) => {
    const f = line.split(";");
    return {
      fecha: parseEsDate(f[0] || ""),
      isin: (f[1] || "").trim(),
      valor: (f[2] || "").trim(),
      tipoActivo: (f[3] || "").trim().toLowerCase(),
      divisa: (f[5] || "EUR").trim().toUpperCase(),
      operacion: (f[6] || "").trim().toLowerCase(),
      titulos: parseEsNumber(f[7]) || 0,
      precioUnitario: parseEsNumber(f[8]) || 0,
      titulosNetos: parseEsNumber(f[12]) || 0,
    };
  });
  rows.sort((a, b) => a.fecha - b.fecha);
  return rows;
}

function consolidatePositions(rows) {
  const state = new Map();

  for (const row of rows) {
    if (!row.isin || row.titulos === 0) continue; // sin titulos: ordenes pendientes, se ignoran

    if (!state.has(row.isin)) {
      state.set(row.isin, {
        isin: row.isin,
        name: row.valor,
        type: TIPO_ACTIVO_MAP[row.tipoActivo] || "Acción",
        currency: row.divisa,
        qty: 0,
        costNative: 0,
      });
    }
    const pos = state.get(row.isin);
    const isEntry = row.operacion === "compra" || row.operacion === "suscripcion";
    const isExit = row.operacion === "venta" || row.operacion === "reembolso";

    if (isEntry) {
      pos.qty += row.titulos;
      pos.costNative += row.titulos * row.precioUnitario;
    } else if (isExit) {
      if (pos.qty > 0) {
        const avgNative = pos.costNative / pos.qty;
        const removeQty = Math.min(row.titulos, pos.qty);
        pos.costNative -= avgNative * removeQty;
        pos.qty -= removeQty;
      }
    }
  }

  return [...state.values()];
}

async function resolveIsins(isins) {
  if (isins.length === 0) return {};
  const res = await fetch(`/api/resolve?isins=${encodeURIComponent(isins.join(","))}`);
  const results = await res.json();
  return Object.fromEntries(results.map((r) => [r.isin, r]));
}

function logImport(msg) {
  const el = document.getElementById("import-log");
  el.textContent += msg + "\n";
  el.scrollTop = el.scrollHeight;
}

document.getElementById("csv-import-btn").addEventListener("click", async () => {
  const fileInput = document.getElementById("csv-file");
  const logEl = document.getElementById("import-log");
  logEl.textContent = "";

  const file = fileInput.files[0];
  if (!file) {
    logImport("Elegí primero un archivo CSV.");
    return;
  }

  const text = await file.text();
  const rows = parseMovementsCsv(text);
  logImport(`Leídas ${rows.length} filas de movimientos.`);

  const positions = consolidatePositions(rows);
  const open = positions.filter((p) => p.qty > 0.0001);
  const closed = positions.filter((p) => p.qty <= 0.0001);

  logImport(`${open.length} posiciones abiertas, ${closed.length} cerradas (ignoradas).`);

  const resolved = await resolveIsins(open.map((p) => p.isin));

  let added = 0;
  let updated = 0;
  const unresolved = [];

  for (const pos of open) {
    const match = resolved[pos.isin];
    const symbol = match && match.symbol ? match.symbol : pos.isin;
    if (!match || !match.symbol) unresolved.push(`${pos.isin} (${pos.name})`);

    const existing = holdings.find((h) => h.isin === pos.isin);
    const record = {
      id: existing ? existing.id : crypto.randomUUID(),
      isin: pos.isin,
      symbol,
      name: pos.name,
      type: pos.type,
      currency: pos.currency,
      quantity: pos.qty,
      avgCostNative: pos.costNative / pos.qty,
      lastPrice: null,
      quoteError: null,
    };

    if (existing) {
      Object.assign(existing, record, { id: existing.id });
      updated++;
    } else {
      holdings.push(record);
      added++;
    }
  }

  // quita posiciones que el archivo dice que quedaron en 0 (ventas/reembolsos totales)
  const closedIsins = new Set(closed.map((p) => p.isin));
  const before = holdings.length;
  holdings = holdings.filter((h) => !h.isin || !closedIsins.has(h.isin));
  const removed = before - holdings.length;

  saveHoldings(holdings);
  logImport(`Importación completa: ${added} nuevas, ${updated} actualizadas, ${removed} cerradas eliminadas.`);
  if (unresolved.length) {
    logImport(`No se pudo resolver el ticker de: ${unresolved.join(", ")}. Editá el símbolo manualmente si hace falta.`);
  }

  render();
  refreshPrices();
});

render();
refreshPrices();
