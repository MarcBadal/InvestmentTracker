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

const MOVEMENT_TYPES = {
  compra: { label: "Compra", tipo: "entrada" },
  suscripcion: { label: "Suscripción", tipo: "entrada" },
  transferencia_entrada: { label: "Transferencia (entrada)", tipo: "entrada" },
  venta: { label: "Venta", tipo: "salida" },
  reembolso: { label: "Reembolso", tipo: "salida" },
  transferencia_salida: { label: "Transferencia (salida)", tipo: "salida" },
};

function replayMovements(movements) {
  let qty = 0;
  let costNative = 0;
  const sorted = [...movements].sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  for (const m of sorted) {
    const info = MOVEMENT_TYPES[m.kind];
    if (!info) continue;
    if (info.tipo === "entrada") {
      qty += m.titulos;
      costNative += m.titulos * m.precioUnitario;
    } else if (qty > 0) {
      const avgNative = costNative / qty;
      const removeQty = Math.min(m.titulos, qty);
      costNative -= avgNative * removeQty;
      qty -= removeQty;
    }
  }
  return { qty, costNative };
}

const CATEGORICAL_HUES = [
  { light: "#2a78d6", dark: "#3987e5" },
  { light: "#eb6834", dark: "#d95926" },
  { light: "#1baf7a", dark: "#199e70" },
  { light: "#eda100", dark: "#c98500" },
  { light: "#e87ba4", dark: "#d55181" },
  { light: "#008300", dark: "#008300" },
  { light: "#4a3aa7", dark: "#9085e9" },
  { light: "#e34948", dark: "#e66767" },
];

function recomputeHolding(h) {
  const { qty, costNative } = replayMovements(h.movements);
  h.quantity = qty;
  h.avgCostNative = qty > 0 ? costNative / qty : 0;
}

function ensureMovements(h) {
  if (!h.movements || h.movements.length === 0) {
    h.movements = [
      {
        id: crypto.randomUUID(),
        fecha: new Date().toISOString().slice(0, 10),
        kind: "compra",
        titulos: h.quantity ?? 0,
        precioUnitario: h.avgCostNative ?? h.buyPrice ?? 0,
        divisa: h.currency || "EUR",
      },
    ];
  }
  return h.movements;
}

function loadHoldings() {
  let data;
  try {
    data = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    data = [];
  }
  data.forEach(ensureMovements);
  return data;
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
const expandedIds = new Set();
let editingSymbolId = null;
let cancelingSymbolEdit = false;

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

function renderMovementsPanel(holding) {
  const movs = [...holding.movements].sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  const rows = movs
    .map(
      (m) => `
      <tr data-movement-id="${m.id}">
        <td><input type="date" class="mov-fecha" value="${m.fecha}"></td>
        <td>
          <select class="mov-kind">
            ${Object.entries(MOVEMENT_TYPES)
              .map(([k, v]) => `<option value="${k}" ${m.kind === k ? "selected" : ""}>${v.label}</option>`)
              .join("")}
          </select>
        </td>
        <td><input type="number" step="any" min="0" class="mov-titulos" value="${m.titulos}"></td>
        <td><input type="number" step="any" min="0" class="mov-precio" value="${m.precioUnitario}"></td>
        <td class="remove"><button class="mov-delete" title="Eliminar movimiento">✕</button></td>
      </tr>`
    )
    .join("");

  return `
    <div class="movements-panel" data-holding-id="${holding.id}">
      <table class="movements-table">
        <thead>
          <tr><th>Fecha</th><th>Operaci&oacute;n</th><th>T&iacute;tulos</th><th>Precio unitario (${holding.currency})</th><th></th></tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="5" class="empty-movements">Sin movimientos registrados.</td></tr>`}</tbody>
      </table>
      <button type="button" class="mov-add">+ A&ntilde;adir movimiento</button>
    </div>
  `;
}

function renderTable(rows) {
  const body = document.getElementById("holdings-body");
  const emptyState = document.getElementById("empty-state");
  body.innerHTML = "";

  emptyState.hidden = rows.length > 0;

  rows.forEach((r) => {
    const expanded = expandedIds.has(r.id);
    const tr = document.createElement("tr");
    tr.className = "holding-row";
    const warn = r.quoteError ? ` title="No se pudo actualizar el precio: ${r.quoteError}"` : "";
    const symbolField =
      editingSymbolId === r.id
        ? `<input type="text" class="edit-symbol-input" data-id="${r.id}" value="${r.symbol}" autocomplete="off">`
        : `${r.symbol}${r.quoteError ? " ⚠" : ""} <button class="edit-symbol" type="button" data-id="${r.id}" title="Editar s&iacute;mbolo">&#9998;</button>`;
    tr.innerHTML = `
      <td class="symbol"${warn}><button class="toggle-movements" type="button" data-id="${r.id}">${expanded ? "▾" : "▸"}</button> ${symbolField}</td>
      <td>${r.type}</td>
      <td>${r.quantity}</td>
      <td>${fmtMoney(r.avgCostNative, r.currency)}</td>
      <td>${fmtMoney(r.costEUR)}</td>
      <td>${fmtMoney(r.price, r.currency)}</td>
      <td>${fmtMoney(r.marketValueEUR)}</td>
      <td class="gain ${r.gainEUR >= 0 ? "good" : "bad"}">${r.gainEUR >= 0 ? "▲" : "▼"} ${fmtMoney(Math.abs(r.gainEUR))} (${fmtPct(r.gainPct)})</td>
      <td class="remove"><button class="remove-holding" title="Eliminar" data-id="${r.id}">✕</button></td>
    `;
    body.appendChild(tr);

    const movTr = document.createElement("tr");
    movTr.className = "movements-row";
    movTr.hidden = !expanded;
    const td = document.createElement("td");
    td.colSpan = 9;
    td.innerHTML = renderMovementsPanel(r);
    movTr.appendChild(td);
    body.appendChild(movTr);
  });

  if (editingSymbolId) {
    const input = body.querySelector(`.edit-symbol-input[data-id="${editingSymbolId}"]`);
    if (input) {
      input.focus();
      input.select();
    }
  }
}

function initHoldingsTableEvents() {
  const body = document.getElementById("holdings-body");

  body.addEventListener("click", (e) => {
    const toggleBtn = e.target.closest(".toggle-movements");
    if (toggleBtn) {
      const id = toggleBtn.dataset.id;
      if (expandedIds.has(id)) expandedIds.delete(id);
      else expandedIds.add(id);
      render();
      return;
    }

    const delHoldingBtn = e.target.closest("button.remove-holding");
    if (delHoldingBtn) {
      holdings = holdings.filter((h) => h.id !== delHoldingBtn.dataset.id);
      expandedIds.delete(delHoldingBtn.dataset.id);
      saveHoldings(holdings);
      render();
      return;
    }

    const editSymbolBtn = e.target.closest(".edit-symbol");
    if (editSymbolBtn) {
      editingSymbolId = editSymbolBtn.dataset.id;
      render();
      return;
    }

    const addMovBtn = e.target.closest(".mov-add");
    if (addMovBtn) {
      const holdingId = addMovBtn.closest(".movements-panel").dataset.holdingId;
      const holding = holdings.find((h) => h.id === holdingId);
      holding.movements.push({
        id: crypto.randomUUID(),
        fecha: new Date().toISOString().slice(0, 10),
        kind: "compra",
        titulos: 0,
        precioUnitario: 0,
        divisa: holding.currency || "EUR",
      });
      recomputeHolding(holding);
      saveHoldings(holdings);
      render();
      return;
    }

    const delMovBtn = e.target.closest(".mov-delete");
    if (delMovBtn) {
      const panel = delMovBtn.closest(".movements-panel");
      const holding = holdings.find((h) => h.id === panel.dataset.holdingId);
      const movId = delMovBtn.closest("tr").dataset.movementId;
      holding.movements = holding.movements.filter((m) => m.id !== movId);
      recomputeHolding(holding);
      saveHoldings(holdings);
      render();
    }
  });

  body.addEventListener("change", (e) => {
    const panel = e.target.closest(".movements-panel");
    if (!panel) return;
    const movRow = e.target.closest("tr[data-movement-id]");
    if (!movRow) return;

    const holding = holdings.find((h) => h.id === panel.dataset.holdingId);
    const mov = holding.movements.find((m) => m.id === movRow.dataset.movementId);
    if (!mov) return;

    if (e.target.classList.contains("mov-fecha")) mov.fecha = e.target.value;
    else if (e.target.classList.contains("mov-kind")) mov.kind = e.target.value;
    else if (e.target.classList.contains("mov-titulos")) mov.titulos = parseFloat(e.target.value) || 0;
    else if (e.target.classList.contains("mov-precio")) mov.precioUnitario = parseFloat(e.target.value) || 0;

    recomputeHolding(holding);
    saveHoldings(holdings);
    render();
  });

  function commitSymbolEdit(input) {
    const id = input.dataset.id;
    const holding = holdings.find((h) => h.id === id);
    editingSymbolId = null;
    if (!holding) {
      render();
      return;
    }
    const newSymbol = input.value.trim().toUpperCase();
    if (newSymbol && newSymbol !== holding.symbol) {
      holding.symbol = newSymbol;
      holding.lastPrice = null;
      holding.quoteError = null;
      saveHoldings(holdings);
      render();
      refreshPrices();
      loadPortfolioHistory();
      return;
    }
    render();
  }

  body.addEventListener(
    "focusout",
    (e) => {
      if (!e.target.classList.contains("edit-symbol-input")) return;
      if (cancelingSymbolEdit) return;
      commitSymbolEdit(e.target);
    },
    true
  );

  body.addEventListener("keydown", (e) => {
    if (!e.target.classList.contains("edit-symbol-input")) return;
    if (e.key === "Enter") {
      e.target.blur();
    } else if (e.key === "Escape") {
      cancelingSymbolEdit = true;
      editingSymbolId = null;
      render();
      cancelingSymbolEdit = false;
    }
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

// ---------- Evolución histórica y proyección ----------

function fmtAxisDate(tsSeconds) {
  return new Date(tsSeconds * 1000).toLocaleDateString("es-ES", { month: "short", year: "2-digit" });
}

function fmtTooltipDate(tsSeconds) {
  return new Date(tsSeconds * 1000).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
}

function nearestPriceAtOrBefore(points, ts) {
  let lo = 0;
  let hi = points.length - 1;
  let ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= ts) {
      ans = points[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function quantityAtDate(movements, cutoffMs) {
  const relevant = movements.filter((m) => new Date(m.fecha).getTime() <= cutoffMs);
  return replayMovements(relevant).qty;
}

function buildAlignedSeries(holding, masterTs, historyBySymbol, fxPoints) {
  const rec = historyBySymbol[holding.symbol];
  if (!rec || !rec.points || !rec.points.length) return masterTs.map(() => null);
  const currency = holding.currency || rec.currency || "EUR";
  return masterTs.map((ts) => {
    const pricePt = nearestPriceAtOrBefore(rec.points, ts);
    if (!pricePt) return null;
    const qty = quantityAtDate(holding.movements, ts * 1000);
    if (qty <= 0.0001) return null;
    const valueNative = qty * pricePt.close;
    if (currency === "EUR") return valueNative;
    const fxPt = fxPoints ? nearestPriceAtOrBefore(fxPoints, ts) : null;
    if (!fxPt || !fxPt.close) return null;
    return valueNative / fxPt.close;
  });
}

function buildLinePath(xs, ys, xScale, yScale) {
  let d = "";
  let open = false;
  for (let i = 0; i < xs.length; i++) {
    if (ys[i] == null) {
      open = false;
      continue;
    }
    d += `${open ? "L" : "M"}${xScale(xs[i]).toFixed(1)},${yScale(ys[i]).toFixed(1)} `;
    open = true;
  }
  return d.trim();
}

function buildAreaPath(xs, ys, xScale, yScale, baselineY) {
  let d = "";
  let seg = [];
  const flush = () => {
    if (seg.length >= 2) {
      let path = `M${seg[0][0].toFixed(1)},${baselineY.toFixed(1)} `;
      seg.forEach(([x, y]) => {
        path += `L${x.toFixed(1)},${y.toFixed(1)} `;
      });
      path += `L${seg[seg.length - 1][0].toFixed(1)},${baselineY.toFixed(1)} Z`;
      d += path + " ";
    }
    seg = [];
  };
  for (let i = 0; i < xs.length; i++) {
    if (ys[i] == null) {
      flush();
      continue;
    }
    seg.push([xScale(xs[i]), yScale(ys[i])]);
  }
  flush();
  return d.trim();
}

function renderLineChart({ svgEl, tooltipEl, legendEl, tableEl, xValues, series, width, height, compact }) {
  const svgNS = "http://www.w3.org/2000/svg";
  const W = width || 640;
  const H = height || (compact ? 130 : 240);
  const padLeft = compact ? 8 : 56;
  const padRight = compact ? 8 : 16;
  const padTop = compact ? 8 : 16;
  const padBottom = compact ? 8 : 28;
  const plotW = W - padLeft - padRight;
  const plotH = H - padTop - padBottom;

  svgEl.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svgEl.innerHTML = "";
  if (legendEl) legendEl.innerHTML = "";
  if (tableEl) tableEl.innerHTML = "";
  if (tooltipEl) tooltipEl.hidden = true;

  const hasData = xValues.length > 0 && series.some((s) => s.values.some((v) => v != null));
  if (!hasData) {
    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("x", String(W / 2));
    text.setAttribute("y", String(H / 2));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("class", "chart-axis-label");
    text.textContent = "Sin datos históricos todavía";
    svgEl.appendChild(text);
    return;
  }

  const dark = isDarkMode();
  const xMin = xValues[0];
  const xMax = xValues[xValues.length - 1];
  let yMax = 0;
  series.forEach((s) => s.values.forEach((v) => {
    if (v != null && v > yMax) yMax = v;
  }));
  yMax = yMax <= 0 ? 1 : yMax * 1.12;

  const xScale = (x) => padLeft + (xMax === xMin ? 0 : ((x - xMin) / (xMax - xMin)) * plotW);
  const yScale = (y) => padTop + plotH - (y / yMax) * plotH;
  const baselineY = yScale(0);

  const g = document.createElementNS(svgNS, "g");

  if (compact) {
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", String(padLeft));
    line.setAttribute("x2", String(W - padRight));
    line.setAttribute("y1", baselineY.toFixed(1));
    line.setAttribute("y2", baselineY.toFixed(1));
    line.setAttribute("class", "chart-gridline");
    g.appendChild(line);
  } else {
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const val = (yMax / steps) * i;
      const y = yScale(val);
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", String(padLeft));
      line.setAttribute("x2", String(W - padRight));
      line.setAttribute("y1", y.toFixed(1));
      line.setAttribute("y2", y.toFixed(1));
      line.setAttribute("class", "chart-gridline");
      g.appendChild(line);

      const label = document.createElementNS(svgNS, "text");
      label.setAttribute("x", String(padLeft - 8));
      label.setAttribute("y", (y + 3).toFixed(1));
      label.setAttribute("text-anchor", "end");
      label.setAttribute("class", "chart-axis-label");
      label.textContent = val.toLocaleString("es-ES", { maximumFractionDigits: 0 });
      g.appendChild(label);
    }

    const tickCount = Math.min(5, xValues.length);
    for (let i = 0; i < tickCount; i++) {
      const idx = Math.round((i / (tickCount - 1 || 1)) * (xValues.length - 1));
      const x = xScale(xValues[idx]);
      const label = document.createElementNS(svgNS, "text");
      label.setAttribute("x", x.toFixed(1));
      label.setAttribute("y", String(H - 8));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("class", "chart-axis-label");
      label.textContent = fmtAxisDate(xValues[idx]);
      g.appendChild(label);
    }
  }

  series.forEach((s) => {
    const color = dark ? s.color.dark : s.color.light;

    if (s.area) {
      const areaPath = buildAreaPath(xValues, s.values, xScale, yScale, baselineY);
      if (areaPath) {
        const path = document.createElementNS(svgNS, "path");
        path.setAttribute("d", areaPath);
        path.setAttribute("class", "chart-area");
        path.setAttribute("fill", color);
        g.appendChild(path);
      }
    }

    const linePath = buildLinePath(xValues, s.values, xScale, yScale);
    if (linePath) {
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", linePath);
      path.setAttribute("class", "chart-line" + (s.dashed ? " dashed" : ""));
      path.setAttribute("stroke", color);
      if (s.opacity != null) path.setAttribute("opacity", String(s.opacity));
      g.appendChild(path);
    }

    for (let i = s.values.length - 1; i >= 0; i--) {
      if (s.values[i] != null) {
        const cx = xScale(xValues[i]);
        const cy = yScale(s.values[i]);
        const dot = document.createElementNS(svgNS, "circle");
        dot.setAttribute("cx", cx.toFixed(1));
        dot.setAttribute("cy", cy.toFixed(1));
        dot.setAttribute("r", compact ? "3" : "4");
        dot.setAttribute("fill", color);
        dot.setAttribute("class", "chart-end-dot");
        g.appendChild(dot);

        if (s.showEndLabel && !compact) {
          const label = document.createElementNS(svgNS, "text");
          const nearRight = cx + 6 > W - padRight - 40;
          label.setAttribute("x", (nearRight ? cx - 6 : cx + 6).toFixed(1));
          label.setAttribute("y", (cy - 8).toFixed(1));
          label.setAttribute("text-anchor", nearRight ? "end" : "start");
          label.setAttribute("class", "chart-end-label");
          label.textContent = fmtMoney(s.values[i]);
          g.appendChild(label);
        }
        break;
      }
    }

    if (s.markers) {
      s.markers.forEach((m) => {
        const cx = xScale(m.x);
        const cy = yScale(m.y);
        const dot = document.createElementNS(svgNS, "circle");
        dot.setAttribute("cx", cx.toFixed(1));
        dot.setAttribute("cy", cy.toFixed(1));
        dot.setAttribute("r", "4");
        dot.setAttribute("fill", color);
        dot.setAttribute("class", "chart-end-dot");
        g.appendChild(dot);

        const label = document.createElementNS(svgNS, "text");
        const nearRight = cx + 6 > W - padRight - 60;
        label.setAttribute("x", (nearRight ? cx - 6 : cx + 6).toFixed(1));
        label.setAttribute("y", (cy - 8).toFixed(1));
        label.setAttribute("text-anchor", nearRight ? "end" : "start");
        label.setAttribute("class", "chart-end-label");
        label.textContent = `${m.label}: ${fmtMoney(m.y)}`;
        g.appendChild(label);
      });
    }
  });

  svgEl.appendChild(g);

  if (compact) return;

  const crosshair = document.createElementNS(svgNS, "line");
  crosshair.setAttribute("y1", String(padTop));
  crosshair.setAttribute("y2", String(H - padBottom));
  crosshair.setAttribute("class", "chart-crosshair");
  crosshair.setAttribute("visibility", "hidden");
  svgEl.appendChild(crosshair);

  const overlay = document.createElementNS(svgNS, "rect");
  overlay.setAttribute("x", String(padLeft));
  overlay.setAttribute("y", String(padTop));
  overlay.setAttribute("width", String(plotW));
  overlay.setAttribute("height", String(plotH));
  overlay.setAttribute("class", "chart-hit-overlay");
  svgEl.appendChild(overlay);

  if (tooltipEl) {
    const wrap = svgEl.parentElement;
    const showTooltip = (evt) => {
      const rect = svgEl.getBoundingClientRect();
      const px = ((evt.clientX - rect.left) / rect.width) * W;
      let closestIdx = 0;
      let minDist = Infinity;
      xValues.forEach((x, i) => {
        const dist = Math.abs(xScale(x) - px);
        if (dist < minDist) {
          minDist = dist;
          closestIdx = i;
        }
      });
      const x = xValues[closestIdx];
      crosshair.setAttribute("x1", xScale(x).toFixed(1));
      crosshair.setAttribute("x2", xScale(x).toFixed(1));
      crosshair.setAttribute("visibility", "visible");

      tooltipEl.innerHTML = "";
      const dateEl = document.createElement("div");
      dateEl.className = "tt-date";
      dateEl.textContent = fmtTooltipDate(x);
      tooltipEl.appendChild(dateEl);

      series.forEach((s) => {
        const v = s.values[closestIdx];
        if (v == null) return;
        const color = dark ? s.color.dark : s.color.light;
        const row = document.createElement("div");
        row.className = "tt-row";
        const key = document.createElement("span");
        key.className = "tt-key";
        key.style.background = color;
        const name = document.createElement("span");
        name.className = "tt-name";
        name.textContent = s.name;
        const value = document.createElement("span");
        value.className = "tt-value";
        value.textContent = fmtMoney(v);
        row.appendChild(key);
        row.appendChild(name);
        row.appendChild(value);
        tooltipEl.appendChild(row);
      });

      tooltipEl.hidden = false;
      const wrapRect = wrap.getBoundingClientRect();
      let left = evt.clientX - wrapRect.left + 12;
      if (left + 160 > wrapRect.width) left = evt.clientX - wrapRect.left - 172;
      tooltipEl.style.left = `${left}px`;
      tooltipEl.style.top = `${Math.max(0, evt.clientY - wrapRect.top - 40)}px`;
    };
    overlay.addEventListener("pointermove", showTooltip);
    overlay.addEventListener("pointerleave", () => {
      tooltipEl.hidden = true;
      crosshair.setAttribute("visibility", "hidden");
    });
  }

  if (legendEl && series.length >= 2) {
    series.forEach((s) => {
      const color = dark ? s.color.dark : s.color.light;
      const item = document.createElement("div");
      item.className = "legend-item";
      const swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.style.background = color;
      if (s.dashed) swatch.style.opacity = "0.6";
      const label = document.createElement("span");
      label.className = "legend-label";
      label.textContent = s.name;
      item.appendChild(swatch);
      item.appendChild(label);
      legendEl.appendChild(item);
    });
  }

  if (tableEl) {
    buildDataTable(tableEl, xValues, series);
  }
}

function buildDataTable(tableEl, xValues, series) {
  const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    const thDate = document.createElement("th");
    thDate.textContent = "Fecha";
    headRow.appendChild(thDate);
    series.forEach((s) => {
      const th = document.createElement("th");
      th.textContent = s.name;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    xValues.forEach((x, i) => {
      if (series.every((s) => s.values[i] == null)) return;
      const tr = document.createElement("tr");
      const tdDate = document.createElement("td");
      tdDate.textContent = fmtTooltipDate(x);
      tr.appendChild(tdDate);
      series.forEach((s) => {
        const td = document.createElement("td");
        td.textContent = s.values[i] == null ? "—" : fmtMoney(s.values[i]);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableEl.appendChild(table);
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

let lastPortfolioHistory = null;

async function fetchHistory(symbols, range) {
  const res = await fetch(`/api/history?symbols=${encodeURIComponent(symbols.join(","))}&range=${range}&interval=1wk`);
  return res.json();
}

function renderHistoryCharts() {
  const totalSvg = document.getElementById("chart-total");
  const totalTooltip = document.getElementById("chart-total-tooltip");
  const totalTable = document.getElementById("chart-total-table");
  const assetsGrid = document.getElementById("chart-assets-grid");
  const assetsTable = document.getElementById("chart-assets-table");

  closeAssetDetail();

  if (!lastPortfolioHistory) {
    renderLineChart({ svgEl: totalSvg, tooltipEl: totalTooltip, tableEl: totalTable, xValues: [], series: [] });
    assetsGrid.innerHTML = "";
    assetsTable.innerHTML = "";
    renderProjectionChart();
    return;
  }

  const { masterTs, totalValues, assetSeries } = lastPortfolioHistory;

  renderLineChart({
    svgEl: totalSvg,
    tooltipEl: totalTooltip,
    tableEl: totalTable,
    xValues: masterTs,
    series: [{ name: "Valor total", color: CATEGORICAL_HUES[0], values: totalValues, area: true, showEndLabel: true }],
  });

  const nonEmpty = assetSeries.filter((s) => s.values.some((v) => v != null));
  const tileSeries = nonEmpty.map((s, i) => ({
    name: s.holding.symbol,
    color: CATEGORICAL_HUES[i % CATEGORICAL_HUES.length],
    values: s.values,
    area: true,
  }));

  renderAssetGrid(assetsGrid, masterTs, tileSeries);
  buildDataTable(assetsTable, masterTs, tileSeries);

  renderProjectionChart();
}

function renderAssetGrid(gridEl, masterTs, tileSeries) {
  gridEl.innerHTML = "";
  if (!tileSeries.length) {
    gridEl.innerHTML = `<p class="chart-hint">Sin datos históricos todavía.</p>`;
    return;
  }

  tileSeries.forEach((s) => {
    const lastValue = [...s.values].reverse().find((v) => v != null);

    const card = document.createElement("button");
    card.type = "button";
    card.className = "mini-chart-card";
    card.innerHTML = `
      <div class="mini-chart-header">
        <span class="mini-chart-symbol">${s.name}</span>
        <span class="mini-chart-value">${lastValue != null ? fmtMoney(lastValue) : "—"}</span>
      </div>
      <svg viewBox="0 0 260 90" role="img" aria-label="Evolución de ${s.name}"></svg>
    `;
    const svg = card.querySelector("svg");
    renderLineChart({
      svgEl: svg,
      xValues: masterTs,
      series: [s],
      width: 260,
      height: 90,
      compact: true,
    });
    card.addEventListener("click", () => openAssetDetail(s.name, masterTs, s));
    gridEl.appendChild(card);
  });
}

function openAssetDetail(name, xValues, s) {
  const overlay = document.getElementById("asset-modal-overlay");
  const title = document.getElementById("asset-modal-title");
  const svg = document.getElementById("chart-asset-detail");
  const tooltip = document.getElementById("chart-asset-detail-tooltip");
  const table = document.getElementById("chart-asset-detail-table");

  title.textContent = name;
  renderLineChart({
    svgEl: svg,
    tooltipEl: tooltip,
    tableEl: table,
    xValues,
    series: [{ ...s, showEndLabel: true }],
    width: 960,
    height: 420,
  });
  overlay.hidden = false;
}

function closeAssetDetail() {
  const overlay = document.getElementById("asset-modal-overlay");
  if (overlay) overlay.hidden = true;
}

function initAssetDetailModal() {
  const overlay = document.getElementById("asset-modal-overlay");
  document.getElementById("asset-modal-close").addEventListener("click", closeAssetDetail);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeAssetDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) closeAssetDetail();
  });
}

function renderProjectionChart() {
  const svg = document.getElementById("chart-projection");
  const tooltip = document.getElementById("chart-projection-tooltip");
  const legend = document.getElementById("chart-projection-legend");
  const table = document.getElementById("chart-projection-table");
  const note = document.getElementById("projection-note");

  const PROJ_W = 960;
  const PROJ_H = 420;

  if (!lastPortfolioHistory) {
    renderLineChart({ svgEl: svg, tooltipEl: tooltip, legendEl: legend, tableEl: table, xValues: [], series: [], width: PROJ_W, height: PROJ_H });
    note.textContent = "Cargá el histórico de precios para ver la proyección.";
    return;
  }

  const { masterTs, totalValues } = lastPortfolioHistory;
  const firstIdx = totalValues.findIndex((v) => v != null);
  let lastIdx = -1;
  for (let i = totalValues.length - 1; i >= 0; i--) {
    if (totalValues[i] != null) {
      lastIdx = i;
      break;
    }
  }

  if (firstIdx === -1 || lastIdx === -1 || firstIdx === lastIdx) {
    renderLineChart({
      svgEl: svg,
      tooltipEl: tooltip,
      legendEl: legend,
      tableEl: table,
      xValues: masterTs,
      series: [{ name: "Valor total", color: CATEGORICAL_HUES[0], values: totalValues, area: true }],
      width: PROJ_W,
      height: PROJ_H,
    });
    note.textContent = "No hay suficiente historial todavía para proyectar una tendencia.";
    return;
  }

  const t0 = masterTs[firstIdx];
  const v0 = totalValues[firstIdx];
  const t1 = masterTs[lastIdx];
  const v1 = totalValues[lastIdx];
  const yearsSpan = (t1 - t0) / (365.25 * 24 * 3600);

  // Se requiere al menos 1 año de historial: con ventanas más cortas, la tasa
  // anualizada queda dominada por ruido de corto plazo y al componerla a 10 años
  // el resultado se dispara a valores absurdos.
  if (yearsSpan < 1 || v0 <= 0 || v1 <= 0) {
    renderLineChart({
      svgEl: svg,
      tooltipEl: tooltip,
      legendEl: legend,
      tableEl: table,
      xValues: masterTs,
      series: [{ name: "Valor total", color: CATEGORICAL_HUES[0], values: totalValues, area: true }],
      width: PROJ_W,
      height: PROJ_H,
    });
    note.textContent = "Se necesita al menos 1 año de historial para calcular una proyección razonable.";
    return;
  }

  const rawCagr = Math.pow(v1 / v0, 1 / yearsSpan) - 1;
  // Limita la tasa anualizada a un rango creíble a largo plazo: sin este límite,
  // un buen tramo reciente (aunque corto) se compone durante 10 años y da
  // resultados irreales que además aplastan el resto del gráfico.
  const CAGR_MIN = -0.3;
  const CAGR_MAX = 0.2;
  const cagr = Math.min(CAGR_MAX, Math.max(CAGR_MIN, rawCagr));
  const wasClamped = Math.abs(cagr - rawCagr) > 0.0001;

  const seriesLen = masterTs.length;
  const futureTs = [];
  const futureValues = [];
  for (let m = 1; m <= 120; m++) {
    futureTs.push(t1 + m * 30.44 * 24 * 3600);
    futureValues.push(v1 * Math.pow(1 + cagr, m / 12));
  }

  const combinedTs = [...masterTs, ...futureTs];
  const historicalAligned = [...totalValues, ...futureTs.map(() => null)];
  const projectionAligned = [
    ...Array(lastIdx).fill(null),
    v1,
    ...Array(seriesLen - lastIdx - 1).fill(null),
    ...futureValues,
  ];
  const proj5 = futureValues[59];
  const proj10 = futureValues[119];

  renderLineChart({
    svgEl: svg,
    tooltipEl: tooltip,
    legendEl: legend,
    tableEl: table,
    xValues: combinedTs,
    width: PROJ_W,
    height: PROJ_H,
    series: [
      { name: "Histórico", color: CATEGORICAL_HUES[0], values: historicalAligned, area: true },
      {
        name: "Proyección (estimada)",
        color: CATEGORICAL_HUES[0],
        values: projectionAligned,
        dashed: true,
        opacity: 0.7,
        markers: [
          { x: futureTs[59], y: proj5, label: "5 años" },
          { x: futureTs[119], y: proj10, label: "10 años" },
        ],
      },
    ],
  });

  note.textContent =
    `Valor actual: ${fmtMoney(v1)}. Con el crecimiento anual compuesto de los últimos ${yearsSpan.toFixed(1)} años ` +
    `(${(rawCagr * 100).toFixed(1)}% anual${wasClamped ? `, limitado a ${(cagr * 100).toFixed(0)}% para una proyección más realista` : ""}), ` +
    `la proyección simple da ${fmtMoney(proj5)} en 5 años y ${fmtMoney(proj10)} en 10 años. ` +
    `Es una extrapolación lineal del histórico (incluye aportaciones pasadas, no solo rentabilidad) y no garantiza resultados futuros.`;
}

async function loadPortfolioHistory() {
  const statusEl = document.getElementById("history-status");
  const btn = document.getElementById("history-refresh-btn");

  if (holdings.length === 0) {
    statusEl.textContent = "Agregá posiciones para ver la evolución.";
    lastPortfolioHistory = null;
    renderHistoryCharts();
    return;
  }

  const range = document.getElementById("history-range").value;
  btn.disabled = true;
  statusEl.textContent = "Cargando histórico…";

  try {
    const symbols = [...new Set(holdings.map((h) => h.symbol))];
    const needsFx = holdings.some((h) => (h.currency || "USD") !== "EUR");
    const fetchSymbols = needsFx ? [...symbols, "EURUSD=X"] : symbols;
    const results = await fetchHistory(fetchSymbols, range);
    const historyBySymbol = Object.fromEntries(results.map((r) => [r.symbol, r]));

    const fxRec = historyBySymbol["EURUSD=X"];
    const fxPoints = fxRec && fxRec.points.length ? fxRec.points : null;

    let masterTs = [];
    let maxLen = 0;
    symbols.forEach((sym) => {
      const rec = historyBySymbol[sym];
      if (rec && !rec.error && rec.points.length > maxLen) {
        maxLen = rec.points.length;
        masterTs = rec.points.map((p) => p.t);
      }
    });

    if (masterTs.length === 0) {
      statusEl.textContent = "No se pudo cargar el histórico de precios.";
      lastPortfolioHistory = null;
      renderHistoryCharts();
      return;
    }

    const assetSeries = holdings.map((h) => ({
      holding: h,
      values: buildAlignedSeries(h, masterTs, historyBySymbol, fxPoints),
    }));

    const totalValues = masterTs.map((_, i) => {
      let sum = 0;
      let any = false;
      assetSeries.forEach(({ values }) => {
        if (values[i] != null) {
          sum += values[i];
          any = true;
        }
      });
      return any ? sum : null;
    });

    const firstValidIdx = totalValues.findIndex((v) => v != null);
    const trimStart = firstValidIdx > 0 ? firstValidIdx : 0;

    lastPortfolioHistory = {
      masterTs: masterTs.slice(trimStart),
      totalValues: totalValues.slice(trimStart),
      assetSeries: assetSeries.map((s) => ({ holding: s.holding, values: s.values.slice(trimStart) })),
    };

    statusEl.textContent = "Actualizado: " + new Date().toLocaleTimeString("es-ES");
  } catch (err) {
    statusEl.textContent = "Error al cargar el histórico.";
    lastPortfolioHistory = null;
  } finally {
    btn.disabled = false;
    renderHistoryCharts();
  }
}

document.getElementById("history-refresh-btn").addEventListener("click", loadPortfolioHistory);
document.getElementById("history-range").addEventListener("change", loadPortfolioHistory);

document.getElementById("add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.target;
  const symbol = form.symbol.value.trim().toUpperCase();
  if (!symbol) return;

  const quantity = parseFloat(form.quantity.value);
  const buyPrice = parseFloat(form.buyPrice.value);
  const currency = form.currency.value;

  holdings.push({
    id: crypto.randomUUID(),
    symbol,
    type: form.type.value,
    quantity,
    avgCostNative: buyPrice,
    currency,
    lastPrice: null,
    movements: [
      {
        id: crypto.randomUUID(),
        fecha: new Date().toISOString().slice(0, 10),
        kind: "compra",
        titulos: quantity,
        precioUnitario: buyPrice,
        divisa: currency,
      },
    ],
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

function classifyMovementKind(row) {
  if (row.operacion === "compra") return "compra";
  if (row.operacion === "suscripcion") return "suscripcion";
  if (row.operacion === "venta") return "venta";
  if (row.operacion === "reembolso") return "reembolso";
  if (row.titulos > 0) return "transferencia_entrada";
  if (row.titulos < 0) return "transferencia_salida";
  return null;
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
        movements: [],
      });
    }
    const pos = state.get(row.isin);
    const kind = classifyMovementKind(row);
    if (!kind) continue; // operación no reconocida, se ignora

    pos.movements.push({
      id: crypto.randomUUID(),
      fecha: row.fecha.toISOString().slice(0, 10),
      kind,
      titulos: Math.abs(row.titulos),
      precioUnitario: row.precioUnitario,
      divisa: row.divisa,
    });
  }

  return [...state.values()].map((pos) => {
    const { qty, costNative } = replayMovements(pos.movements);
    return { ...pos, qty, costNative };
  });
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
      movements: pos.movements,
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
  loadPortfolioHistory();
});

function initTabs() {
  const buttons = document.querySelectorAll(".tab-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-selected", b === btn ? "true" : "false");
      });
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.hidden = panel.id !== `tab-${btn.dataset.tab}`;
      });
    });
  });
}

initTabs();
initAssetDetailModal();
initHoldingsTableEvents();
render();
refreshPrices();
renderHistoryCharts();
loadPortfolioHistory();
