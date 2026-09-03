const STORAGE_KEY = "investmentTracker.holdings";

const TYPE_COLOR_HEX = {
  "Acción": { light: "#2a78d6", dark: "#3987e5" },
  "ETF": { light: "#eb6834", dark: "#d95926" },
  "Fondo": { light: "#1baf7a", dark: "#199e70" },
  "Liquidez": { light: "#898781", dark: "#898781" },
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
  // Coste en EUR realmente pagado (importe_neto_eur del CSV): incluye comisiones y usa
  // el tipo de cambio del día de la operación, no el de hoy.
  let costEUR = 0;
  let hasEur = true;
  let realizedEUR = 0;
  const sorted = [...movements].sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  for (const m of sorted) {
    const info = MOVEMENT_TYPES[m.kind];
    if (!info) continue;

    // Un traspaso no es dinero que entra ni sale del bolsillo: solo cambia de fondo o de
    // clase de participaciones. Si se tratara como venta + compra nueva, la base de coste
    // se reiniciaría al valor de mercado de ese día y se perdería toda la rentabilidad
    // anterior. Lo identifica la contrapartida (el ISIN del otro lado del traspaso): NO
    // sirve dineroNuevo, que también vale "no" en las ventas y reembolsos a efectivo.
    const traspaso = !!m.contrapartida;

    if (info.tipo === "entrada") {
      // Si no hay coste acumulado que arrastrar (traspaso desde otro ISIN), se usa el
      // importe del movimiento como base.
      const arrastra = traspaso && costNative > 0;
      qty += m.titulos;
      if (!arrastra) {
        costNative += m.titulos * m.precioUnitario;
        if (m.importeEur != null) costEUR += m.importeEur;
        else hasEur = false;
      }
    } else if (qty > 0) {
      const removeQty = Math.min(m.titulos, qty);
      if (!traspaso) {
        const avgNative = costNative / qty;
        const avgEUR = costEUR / qty;
        // Ganancia realizada: lo cobrado por la venta menos el coste medio de lo vendido.
        if (m.importeEur != null) {
          const cobradoEUR = m.importeEur * (removeQty / m.titulos);
          realizedEUR += cobradoEUR - avgEUR * removeQty;
        }
        costNative -= avgNative * removeQty;
        costEUR -= avgEUR * removeQty;
      }
      qty -= removeQty;
    }
  }
  return { qty, costNative, costEUR: hasEur ? costEUR : null, realizedEUR };
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
  const { qty, costNative, costEUR, realizedEUR } = replayMovements(h.movements);
  h.quantity = qty;
  h.avgCostNative = qty > 0 ? costNative / qty : 0;
  h.costEUR = costEUR;
  h.realizedEUR = realizedEUR;
  h.closed = qty <= 0.0001;
}

function ensureMovements(h) {
  if (!h.movements || h.movements.length === 0) {
    h.movements = [
      {
        id: crypto.randomUUID(),
        fecha: toIsoDate(new Date()),
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
  data.forEach((h) => {
    ensureMovements(h);
    recomputeHolding(h); // deja al día closed/realizedEUR/costEUR según los movimientos
  });
  return data;
}

function saveHoldings(holdings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(holdings));
}

// Modo privado: oculta todos los importes y deja solo los porcentajes. Se centraliza en
// fmtMoney porque es por donde pasa cada cifra de dinero de la app.
const PRIVATE_KEY = "investmentTracker.private";
let privateMode = localStorage.getItem(PRIVATE_KEY) === "1";
const MASK = "•••";

function setPrivateMode(on) {
  privateMode = on;
  localStorage.setItem(PRIVATE_KEY, on ? "1" : "0");
}

function fmtMoney(n, currency = "EUR") {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (privateMode) return MASK;
  return n.toLocaleString("es-ES", { style: "currency", currency, maximumFractionDigits: 2 });
}

// Cantidades de títulos: también son un dato patrimonial, se ocultan igual.
function fmtQty(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return privateMode ? MASK : String(n);
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

function renderTiles(rows, realized = 0, cash = 0) {
  const invested = rows.reduce((s, r) => s + r.costEUR, 0);
  const current = rows.reduce((s, r) => s + r.marketValueEUR, 0);
  const gain = current - invested;
  const gainPct = invested > 0 ? (gain / invested) * 100 : 0;

  document.getElementById("tile-invested").textContent = fmtMoney(invested);
  document.getElementById("tile-current").textContent = fmtMoney(current);

  const cashEl = document.getElementById("tile-cash");
  // No se pisa mientras se está escribiendo el saldo a mano.
  if (document.activeElement !== cashEl) {
    cashEl.type = privateMode ? "text" : "number";
    cashEl.value = privateMode ? MASK : cash.toFixed(2);
  }
  cashEl.readOnly = privateMode; // en modo privado no se edita: no se ve lo que hay
  cashEl.title = privateMode
    ? "Desactivá el modo privado para ver o editar el saldo"
    : `Patrimonio total (invertido + líquido): ${fmtMoney(current + cash)}`;

  const patrimonio = current + cash;
  const pctAuto = Math.round(cashAdjust.factor * 100);
  const partes = [];
  // En modo privado el peso de la liquidez sobre el total sí es informativo y no revela
  // el importe.
  if (privateMode) partes.push(`${(patrimonio > 0 ? (cash / patrimonio) * 100 : 0).toFixed(1)}% del patrimonio`);
  else partes.push(`Patrimonio: ${fmtMoney(patrimonio)}`);
  if (cashMovements(holdings).some((m) => m.tipo === "entrada" && m.origen === "auto")) {
    partes.push(`~${pctAuto}% de las compras pagado con liquidez`);
  }
  if (cashAdjust.delta && !privateMode) partes.push(`resto: ${fmtMoney(cashAdjust.delta)}`);
  document.getElementById("cash-note").textContent = partes.join(" · ");

  const gainEl = document.getElementById("tile-gain");
  gainEl.textContent = (gain >= 0 ? "▲ " : "▼ ") + fmtMoney(Math.abs(gain));
  gainEl.className = "value " + (gain >= 0 ? "good" : "bad");

  const realizedEl = document.getElementById("tile-realized");
  realizedEl.textContent = (realized >= 0 ? "▲ " : "▼ ") + fmtMoney(Math.abs(realized));
  realizedEl.className = "value " + (realized >= 0 ? "good" : "bad");
  realizedEl.title = `Ganancia acumulada total (latente + realizada): ${fmtMoney(gain + realized)}`;

  const pctEl = document.getElementById("tile-pct");
  pctEl.textContent = fmtPct(gainPct);
  pctEl.className = "value " + (gainPct >= 0 ? "good" : "bad");
}

function renderMovementsPanel(holding) {
  const movs = [...holding.movements].sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  const rows = movs
    .map(
      (m) => `
      <tr data-movement-id="${m.id}" data-mov-row>
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
        <td>${movementOriginField(m)}</td>
        <td class="remove"><button class="mov-delete" title="Eliminar movimiento">✕</button></td>
      </tr>`
    )
    .join("");

  if (privateMode) {
    return `
      <div class="movements-panel" data-holding-id="${holding.id}">
        <p class="empty-movements">Modo privado activo. Desactiv&aacute; &laquo;Mostrar importes&raquo; para ver y editar los movimientos.</p>
      </div>`;
  }

  return `
    <div class="movements-panel" data-holding-id="${holding.id}">
      <table class="movements-table">
        <thead>
          <tr><th>Fecha</th><th>Operaci&oacute;n</th><th>T&iacute;tulos</th><th>Precio unitario (${holding.currency})</th><th>Origen del dinero</th><th></th></tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="6" class="empty-movements">Sin movimientos registrados.</td></tr>`}</tbody>
      </table>
      <button type="button" class="mov-add">+ A&ntilde;adir movimiento</button>
    </div>
  `;
}

// Selector de origen del dinero. Solo tiene sentido en las entradas: define si la compra
// consumió la liquidez de la cuenta o si el dinero entró de fuera. En las salidas es
// informativo (a liquidez, o traspaso si va directo a otro fondo).
function movementOriginField(m) {
  const info = MOVEMENT_TYPES[m.kind];
  if (m.contrapartida) return `<span class="mov-origin-static">Traspaso</span>`;
  if (!info || info.tipo === "salida") return `<span class="mov-origin-static">&rarr; A liquidez</span>`;
  const origen = m.origen || "auto";
  const opciones = [
    ["auto", "Automático"],
    ["nuevo", "Dinero nuevo"],
    ["liquidez", "De la liquidez"],
  ];
  return `
    <select class="mov-origen">
      ${opciones
        .map(([v, label]) => `<option value="${v}" ${origen === v ? "selected" : ""}>${label}</option>`)
        .join("")}
    </select>`;
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
    const tip = r.quoteError
      ? `No se pudo actualizar el precio: ${r.quoteError}`
      : [r.name, r.quoteName ? `Cotiza como: ${r.quoteName} (${r.symbol}, ${r.quoteCurrency || "?"})` : null]
          .filter(Boolean)
          .join(" — ");
    const warn = tip ? ` title="${tip.replace(/"/g, "&quot;")}"` : "";
    const symbolField =
      editingSymbolId === r.id
        ? `<input type="text" class="edit-symbol-input" data-id="${r.id}" value="${r.symbol}" autocomplete="off">`
        : `${r.symbol}${r.quoteError ? " ⚠" : ""} <button class="edit-symbol" type="button" data-id="${r.id}" title="Editar s&iacute;mbolo">&#9998;</button>`;
    tr.innerHTML = `
      <td class="symbol"${warn}><button class="toggle-movements" type="button" data-id="${r.id}">${expanded ? "▾" : "▸"}</button> ${symbolField}</td>
      <td>${r.type}</td>
      <td>${fmtQty(r.quantity)}</td>
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
        fecha: toIsoDate(new Date()),
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
    else if (e.target.classList.contains("mov-origen")) mov.origen = e.target.value;

    recomputeHolding(holding);
    saveHoldings(holdings);
    render();
    loadPortfolioHistory();
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
      holding.symbolManual = true; // que una reimportación del CSV no lo pise
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

function renderDonut(rows, cash = 0) {
  const byType = {};
  rows.forEach((r) => {
    byType[r.type] = (byType[r.type] || 0) + r.marketValueEUR;
  });
  // El dinero sin invertir también es parte de la cartera: dejarlo fuera del reparto
  // haría creer que estás más invertido de lo que estás.
  if (cash > 0.005) byType["Liquidez"] = cash;
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

  const order = ["Acción", "ETF", "Fondo", "Liquidez"];
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

// Movimientos de la liquidez de la cuenta. Vender o reembolsar no hace desaparecer el
// dinero: queda parado en la cuenta hasta que se reinvierte o se saca al banco.
//   venta/reembolso sin contrapartida -> entra dinero a liquidez
//   traspaso (con contrapartida)      -> no la toca, va de un fondo a otro
//   compra                            -> según su campo origen (auto / nuevo / liquidez)
// El CSV no sirve para saber el origen: marca dinero_nuevo="si" en todas las compras,
// incluso en las pagadas con el efectivo que ya había en la cuenta.
function cashMovements(holdingList) {
  const movs = [];
  holdingList.forEach((h) => {
    (h.movements || []).forEach((m) => {
      const info = MOVEMENT_TYPES[m.kind];
      if (!info || m.contrapartida) return;
      const importe = m.importeEur != null ? m.importeEur : m.titulos * m.precioUnitario;
      if (!(importe > 0)) return;
      const t = Math.floor(new Date(m.fecha).getTime() / 1000);
      if (Number.isNaN(t)) return;
      movs.push({ t, tipo: info.tipo, importe, origen: m.origen || "auto" });
    });
  });
  return movs.sort((a, b) => a.t - b.t);
}

// Saldo de liquidez a lo largo del tiempo. Por defecto ("auto") una compra se paga con el
// dinero parado que haya disponible: si no, el mismo dinero aparecería a la vez como
// líquido y como la inversión que se compró con él, inflando el patrimonio.
// `autoFactor` es la fracción de las compras "auto" que sale de la liquidez; se calibra
// contra el saldo real que declara el usuario, porque el CSV no distingue el origen.
function cashTimeline(holdingList, autoFactor = 1) {
  const points = [];
  let balance = 0;
  cashMovements(holdingList).forEach((m) => {
    if (m.tipo === "salida") {
      balance += m.importe;
    } else if (m.origen !== "nuevo") {
      const pedido = m.origen === "liquidez" ? m.importe : m.importe * autoFactor;
      balance -= Math.min(balance, pedido);
    }
    points.push({ t: m.t, balance });
  });
  return points;
}

// El CSV no dice qué compras se pagaron con la liquidez que ya había (las marca todas
// como dinero nuevo), así que el saldo deducido puede quedar alto. Este ajuste guarda la
// diferencia con el saldo real que indique el usuario, con la fecha en que lo indicó,
// para no falsear el histórico anterior a esa corrección.
const CASH_ADJUST_KEY = "investmentTracker.cashAdjust";

function loadCashAdjust() {
  try {
    const raw = JSON.parse(localStorage.getItem(CASH_ADJUST_KEY));
    if (raw && typeof raw.factor === "number") return raw;
  } catch {
    /* sin ajuste guardado */
  }
  return { factor: 1, delta: 0, fecha: null };
}

let cashAdjust = loadCashAdjust();

function cashBalanceAt(points, ts, { withAdjust = true } = {}) {
  let balance = 0;
  for (const p of points) {
    if (p.t > ts) break;
    balance = p.balance;
  }
  // Resto que no se pudo explicar repartiendo entre las compras (p. ej. un ingreso o una
  // retirada al banco, que no están en el CSV). Se aplica desde la fecha en que se indicó.
  if (withAdjust && cashAdjust.delta && cashAdjust.fecha) {
    const adjustTs = Math.floor(new Date(cashAdjust.fecha).getTime() / 1000);
    if (ts >= adjustTs) balance += cashAdjust.delta;
  }
  return balance;
}

function currentCashPoints() {
  return cashTimeline(holdings, cashAdjust.factor);
}

function currentCash(opts) {
  return cashBalanceAt(currentCashPoints(), Math.floor(Date.now() / 1000), opts);
}

function finalBalance(factor) {
  const pts = cashTimeline(holdings, factor);
  return pts.length ? pts[pts.length - 1].balance : 0;
}

// Calibra qué parte de las compras "auto" salió de la liquidez para que el saldo final
// coincida con el que declara el usuario. Es la única incógnita: el CSV marca todas las
// compras igual. Lo que no se pueda explicar así queda como resto puntual.
function setCashBalance(target) {
  const maxBal = finalBalance(0); // ninguna compra sale de la liquidez
  const minBal = finalBalance(1); // todas salen de la liquidez

  let factor;
  if (target >= maxBal) factor = 0;
  else if (target <= minBal) factor = 1;
  else {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (finalBalance(mid) > target) lo = mid;
      else hi = mid;
    }
    factor = (lo + hi) / 2;
  }

  const delta = target - finalBalance(factor);
  cashAdjust = {
    factor,
    delta: Math.abs(delta) < 0.005 ? 0 : delta,
    fecha: Math.abs(delta) < 0.005 ? null : toIsoDate(new Date()),
  };
  localStorage.setItem(CASH_ADJUST_KEY, JSON.stringify(cashAdjust));
}

// Resumen de lo aportado y lo recuperado en una posición. Los traspasos se excluyen:
// no son dinero que entró ni salió del bolsillo, solo cambió de fondo.
function positionCashflows(h) {
  let invertido = 0;
  let recuperado = 0;
  (h.movements || []).forEach((m) => {
    const info = MOVEMENT_TYPES[m.kind];
    if (!info || m.contrapartida || m.importeEur == null) return;
    if (info.tipo === "entrada") invertido += m.importeEur;
    else recuperado += m.importeEur;
  });
  const fechas = (h.movements || []).map((m) => m.fecha).filter(Boolean).sort();
  return { invertido, recuperado, desde: fechas[0], hasta: fechas[fechas.length - 1] };
}

function renderClosedPositions() {
  const body = document.getElementById("closed-body");
  const empty = document.getElementById("closed-empty");
  body.innerHTML = "";

  // Cerradas, y también abiertas con ventas parciales (ahí ya hay ganancia realizada).
  const past = holdings
    .filter((h) => h.closed || Math.abs(h.realizedEUR || 0) > 0.005)
    .map((h) => ({ h, ...positionCashflows(h) }))
    .sort((a, b) => String(b.hasta || "").localeCompare(String(a.hasta || "")));

  empty.hidden = past.length > 0;

  let totalInv = 0;
  let totalRec = 0;
  let totalGain = 0;

  past.forEach(({ h, invertido, recuperado, desde, hasta }) => {
    const gain = h.realizedEUR || 0;
    const pct = invertido > 0 ? (gain / invertido) * 100 : null;
    totalInv += invertido;
    totalRec += recuperado;
    totalGain += gain;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="symbol">${h.symbol}${h.closed ? "" : ' <span class="badge-partial">parcial</span>'}</td>
      <td>${h.name || "—"}</td>
      <td>${h.type || "—"}</td>
      <td>${fmtShortDate(desde)} → ${fmtShortDate(hasta)}</td>
      <td>${fmtMoney(invertido)}</td>
      <td>${fmtMoney(recuperado)}</td>
      <td class="gain ${gain >= 0 ? "good" : "bad"}">${gain >= 0 ? "▲" : "▼"} ${fmtMoney(Math.abs(gain))}</td>
      <td class="gain ${gain >= 0 ? "good" : "bad"}">${pct == null ? "—" : fmtPct(pct)}</td>
    `;
    body.appendChild(tr);
  });

  const totalPct = totalInv > 0 ? (totalGain / totalInv) * 100 : 0;
  document.getElementById("tile-closed-received").textContent = fmtMoney(totalRec);
  document.getElementById("tile-closed-invested").textContent = fmtMoney(totalInv);

  const gainEl = document.getElementById("tile-closed-gain");
  gainEl.textContent = (totalGain >= 0 ? "▲ " : "▼ ") + fmtMoney(Math.abs(totalGain));
  gainEl.className = "value " + (totalGain >= 0 ? "good" : "bad");

  const pctEl = document.getElementById("tile-closed-pct");
  pctEl.textContent = fmtPct(totalPct);
  pctEl.className = "value " + (totalPct >= 0 ? "good" : "bad");
}

function fmtShortDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es-ES", { month: "short", year: "numeric" });
}

function render() {
  // Las cerradas se conservan (aportan ganancia realizada e histórico) pero no son
  // posiciones actuales: fuera de la tabla, el donut y el valor de mercado.
  const rows = holdings.filter((h) => !h.closed).map(computeRow);
  const realized = holdings.reduce((s, h) => s + (h.realizedEUR || 0), 0);
  const cash = currentCash();
  renderTiles(rows, realized, cash);
  renderTable(rows);
  renderDonut(rows, cash);
  renderClosedPositions();
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

// Precios tomados de los propios movimientos importados. Sirven de respaldo cuando
// Yahoo no tiene histórico para esas fechas (típico en fondos: la clase nueva de
// participaciones solo cotiza desde su creación, aunque la posición sea más antigua).
function movementPricePoints(holding) {
  return (holding.movements || [])
    .filter((m) => m.precioUnitario > 0 && m.fecha)
    .map((m) => ({ t: Math.floor(new Date(m.fecha).getTime() / 1000), close: m.precioUnitario }))
    .sort((a, b) => a.t - b.t);
}

// Elige el precio de una fecha entre el de mercado y el pagado según el CSV.
// Se queda con el del CSV cuando el de mercado está en otra escala (más de 5x de
// diferencia): pasa en cambios de clase de participaciones o splits, donde la serie
// de Yahoo es de la clase nueva y en esa fecha aún se tenía la vieja.
const SCALE_MISMATCH = 5;

function priceAt(marketPoints, ownPoints, ts) {
  const mkt = marketPoints ? nearestPriceAtOrBefore(marketPoints, ts) : null;
  const own = ownPoints.length ? nearestPriceAtOrBefore(ownPoints, ts) : null;
  if (!mkt) return own ? own.close : null;
  if (!own || !own.close) return mkt.close;
  const ratio = mkt.close / own.close;
  if (ratio > SCALE_MISMATCH || ratio < 1 / SCALE_MISMATCH) return own.close;
  return mkt.close;
}

function buildAlignedSeries(holding, masterTs, historyBySymbol, fxPoints) {
  const rec = historyBySymbol[holding.symbol];
  const marketPoints = rec && rec.points && rec.points.length ? rec.points : null;
  const ownPoints = movementPricePoints(holding);
  if (!marketPoints && !ownPoints.length) return masterTs.map(() => null);
  const currency = holding.currency || (rec && rec.currency) || "EUR";
  return masterTs.map((ts) => {
    const qty = quantityAtDate(holding.movements, ts * 1000);
    if (qty <= 0.0001) return null;
    const price = priceAt(marketPoints, ownPoints, ts);
    if (price == null) return null;
    const valueNative = qty * price;
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
      label.textContent = privateMode ? "" : val.toLocaleString("es-ES", { maximumFractionDigits: 0 });
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

  // Las cerradas no necesitan cotización actual: ya no se tienen.
  const symbols = [...new Set(holdings.filter((h) => !h.closed).map((h) => h.symbol))];
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
      if (h.closed) return h;
      const q = bySymbol[h.symbol];
      if (!q) return { ...h, quoteError: "sin respuesta" };
      if (q.price == null) return { ...h, quoteError: q.error };

      const price = priceInHoldingCurrency(q, h.currency || "USD");
      if (price == null) {
        return { ...h, quoteError: `cotización en ${q.currency}, no se pudo convertir a ${h.currency}` };
      }
      // No se pisa h.name (el del CSV): se guarda aparte el nombre de lo que realmente
      // cotiza el ticker, para poder detectar un ISIN resuelto al instrumento equivocado.
      return { ...h, lastPrice: price, name: h.name || q.name, quoteName: q.name, quoteCurrency: q.currency, quoteError: null };
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
    document.getElementById("total-series-toggle").hidden = true;
    assetsGrid.innerHTML = "";
    assetsTable.innerHTML = "";
    renderProjectionChart();
    return;
  }

  const { masterTs, totalValues, investedValues, cashValues, assetSeries } = lastPortfolioHistory;

  const allTotalSeries = [
    { key: "total", name: "Total (invertido + líquido)", color: CATEGORICAL_HUES[0], values: totalValues, area: true, showEndLabel: true },
    { key: "invertido", name: "Invertido", color: CATEGORICAL_HUES[2], values: investedValues, showEndLabel: true },
    { key: "liquido", name: "Líquido", color: CATEGORICAL_HUES[3], values: cashValues, showEndLabel: true },
  ];
  // Solo se puede desglosar si en algún momento hubo dinero parado.
  const hasCash = cashValues && cashValues.some((v) => v != null);
  const available = hasCash ? allTotalSeries : [allTotalSeries[0]];

  renderSeriesToggle(available);
  const shown = available.filter((s) => totalSeriesVisible[s.key]);

  renderLineChart({
    svgEl: totalSvg,
    tooltipEl: totalTooltip,
    legendEl: document.getElementById("chart-total-legend"),
    tableEl: totalTable,
    xValues: masterTs,
    series: shown,
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

const TOTAL_SERIES_KEY = "investmentTracker.totalSeries";

function loadTotalSeriesVisible() {
  try {
    const raw = JSON.parse(localStorage.getItem(TOTAL_SERIES_KEY));
    if (raw && typeof raw === "object") return { total: !!raw.total, invertido: !!raw.invertido, liquido: !!raw.liquido };
  } catch {
    /* sin preferencia guardada */
  }
  return { total: true, invertido: true, liquido: true };
}

let totalSeriesVisible = loadTotalSeriesVisible();

function renderSeriesToggle(available) {
  const box = document.getElementById("total-series-toggle");
  box.innerHTML = "";
  // Con una sola serie disponible no hay nada que elegir.
  if (available.length < 2) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  const dark = isDarkMode();
  available.forEach((s) => {
    const active = !!totalSeriesVisible[s.key];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "series-chip" + (active ? " active" : "");
    btn.setAttribute("aria-pressed", active ? "true" : "false");
    btn.innerHTML = `<span class="series-chip-dot" style="background:${dark ? s.color.dark : s.color.light}"></span>${s.name}`;
    btn.addEventListener("click", () => {
      const activos = available.filter((x) => totalSeriesVisible[x.key]);
      // No se permite dejar el gráfico sin ninguna serie.
      if (active && activos.length === 1) return;
      totalSeriesVisible[s.key] = !active;
      localStorage.setItem(TOTAL_SERIES_KEY, JSON.stringify(totalSeriesVisible));
      renderHistoryCharts();
    });
    box.appendChild(btn);
  });
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

const RANGE_YEARS = { "1y": 1, "2y": 2, "5y": 5 };

// Rejilla semanal común a todos los activos. Arranca en el movimiento más antiguo
// (acotado por el rango elegido) y no solo donde empieza el histórico de Yahoo, que
// para algunos fondos es mucho más corto que la posición real.
function buildTimeGrid(holdingList, symbols, historyBySymbol, range) {
  const WEEK = 7 * 24 * 3600;
  const nowTs = Math.floor(Date.now() / 1000);

  let earliest = Infinity;
  let latest = 0;
  symbols.forEach((sym) => {
    const rec = historyBySymbol[sym];
    if (!rec || rec.error || !rec.points.length) return;
    earliest = Math.min(earliest, rec.points[0].t);
    latest = Math.max(latest, rec.points[rec.points.length - 1].t);
  });
  holdingList.forEach((h) => {
    movementPricePoints(h).forEach((p) => {
      earliest = Math.min(earliest, p.t);
    });
  });

  if (!Number.isFinite(earliest)) return [];

  const years = RANGE_YEARS[range];
  if (years) earliest = Math.max(earliest, nowTs - years * 365.25 * 24 * 3600);
  const end = Math.max(latest, nowTs);
  if (end <= earliest) return [earliest];

  const grid = [];
  for (let t = earliest; t <= end; t += WEEK) grid.push(t);
  if (grid[grid.length - 1] < end) grid.push(end);
  return grid;
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

    const masterTs = buildTimeGrid(holdings, symbols, historyBySymbol, range);

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

    // Liquidez en cada fecha: al vender, el dinero no desaparece de la cartera, se queda
    // parado en la cuenta. Sin esto el total muestra una caída falsa el día de la venta.
    const cashPoints = currentCashPoints();
    const cashValues = masterTs.map((ts) => {
      const bal = cashBalanceAt(cashPoints, ts);
      return bal > 0.005 ? bal : null;
    });

    const investedValues = masterTs.map((_, i) => {
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

    const totalValues = masterTs.map((_, i) => {
      if (investedValues[i] == null && cashValues[i] == null) return null;
      return (investedValues[i] || 0) + (cashValues[i] || 0);
    });

    const firstValidIdx = totalValues.findIndex((v) => v != null);
    const trimStart = firstValidIdx > 0 ? firstValidIdx : 0;

    lastPortfolioHistory = {
      masterTs: masterTs.slice(trimStart),
      totalValues: totalValues.slice(trimStart),
      investedValues: investedValues.slice(trimStart),
      cashValues: cashValues.slice(trimStart),
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
        fecha: toIsoDate(new Date()),
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

// Fecha local en formato YYYY-MM-DD. No se usa toISOString() porque convierte a UTC
// y en husos por delante de Greenwich devuelve el día anterior.
function toIsoDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
      importeEur: parseEsNumber(f[11]),
      // ISIN del otro lado de un traspaso; vacío en compras, ventas y reembolsos normales
      contrapartida: (f[15] || "").trim(),
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
      fecha: toIsoDate(row.fecha),
      kind,
      titulos: Math.abs(row.titulos),
      precioUnitario: row.precioUnitario,
      divisa: row.divisa,
      importeEur: row.importeEur,
      contrapartida: row.contrapartida,
    });
  }

  return [...state.values()].map((pos) => {
    const { qty, costNative, costEUR, realizedEUR } = replayMovements(pos.movements);
    return { ...pos, qty, costNative, costEUR, realizedEUR };
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
  const realizadoTotal = positions.reduce((s, p) => s + (p.realizedEUR || 0), 0);

  logImport(
    `${open.length} posiciones abiertas, ${closed.length} cerradas ` +
      `(se conservan por su ganancia realizada: ${fmtMoney(realizadoTotal)}).`
  );

  // Se resuelven también las cerradas: su histórico sigue contando para la evolución
  // de la cartera en las fechas en que sí las tenías.
  const resolved = await resolveIsins(positions.map((p) => p.isin));

  let added = 0;
  let updated = 0;
  const unresolved = [];

  for (const pos of positions) {
    const match = resolved[pos.isin];
    const symbol = match && match.symbol ? match.symbol : pos.isin;
    if ((!match || !match.symbol) && pos.qty > 0.0001) unresolved.push(`${pos.isin} (${pos.name})`);

    const existing = holdings.find((h) => h.isin === pos.isin);
    const keepManualSymbol = existing && existing.symbolManual && existing.symbol;
    const record = {
      id: existing ? existing.id : crypto.randomUUID(),
      isin: pos.isin,
      symbol: keepManualSymbol ? existing.symbol : symbol,
      symbolManual: !!keepManualSymbol,
      name: pos.name,
      type: pos.type,
      currency: pos.currency,
      quantity: pos.qty,
      avgCostNative: pos.qty > 0.0001 ? pos.costNative / pos.qty : 0,
      costEUR: pos.costEUR,
      realizedEUR: pos.realizedEUR,
      closed: pos.qty <= 0.0001,
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

  saveHoldings(holdings);
  logImport(`Importación completa: ${added} nuevas, ${updated} actualizadas.`);
  if (unresolved.length) {
    logImport(`No se pudo resolver el ticker de: ${unresolved.join(", ")}. Editá el símbolo manualmente si hace falta.`);
  }

  render();
  refreshPrices();
  loadPortfolioHistory();
});

function initPrivateToggle() {
  const btn = document.getElementById("private-toggle");
  const paint = () => {
    btn.textContent = privateMode ? "Mostrar importes" : "Ocultar importes";
    btn.setAttribute("aria-pressed", privateMode ? "true" : "false");
    btn.classList.toggle("active", privateMode);
  };
  paint();
  btn.addEventListener("click", () => {
    setPrivateMode(!privateMode);
    paint();
    render();
    renderHistoryCharts();
  });
}

function initCashTile() {
  const input = document.getElementById("tile-cash");
  const commit = () => {
    const value = parseFloat(input.value);
    if (Number.isNaN(value)) {
      render();
      return;
    }
    setCashBalance(value);
    render();
    loadPortfolioHistory();
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
  });
}

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
initPrivateToggle();
initCashTile();
initAssetDetailModal();
initHoldingsTableEvents();
render();
refreshPrices();
renderHistoryCharts();
loadPortfolioHistory();
