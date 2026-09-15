// Proveedores de datos de mercado.
//
// Todos devuelven exactamente las mismas formas que ya consume la app, así que cambiar de
// proveedor no obliga a tocar nada del resto del código:
//
//   quotes(symbols)                 -> [{symbol, price, currency, name, error}]
//   history(symbols, range)         -> [{symbol, currency, points:[{t, close}], error}]
//   resolve(isins)                  -> [{isin, symbol, name, candidates:[{symbol,name,exchange}], error}]
//
// Hay dos:
//   · yahoo       — a través del servidor propio. Sin clave, pero es uso personal: los
//                   términos de Yahoo no permiten redistribuir a terceros.
//   · twelvedata  — desde el navegador con la clave del propio usuario. Es lo que permite
//                   ofrecer esto como servicio sin licencia de redistribución: los datos
//                   los pide su máquina con su licencia, no un servidor central.

const PROVIDER_KEY = "investmentTracker.provider";
const APIKEY_KEY = "investmentTracker.apiKey";

// ---------- Yahoo (servidor propio) ----------

const yahooProvider = {
  id: "yahoo",
  name: "Yahoo Finance (local)",
  needsKey: false,
  note: "Sin clave. Solo uso personal: sus términos no permiten mostrar los datos a terceros.",

  async quotes(symbols) {
    if (!symbols.length) return [];
    const res = await fetch(`/api/quotes?symbols=${encodeURIComponent(symbols.join(","))}`);
    return res.json();
  },

  async history(symbols, range) {
    if (!symbols.length) return [];
    const res = await fetch(
      `/api/history?symbols=${encodeURIComponent(symbols.join(","))}&range=${range}&interval=1wk`
    );
    return res.json();
  },

  async resolve(isins) {
    if (!isins.length) return [];
    const res = await fetch(`/api/resolve?isins=${encodeURIComponent(isins.join(","))}`);
    return res.json();
  },
};

// ---------- Twelve Data (navegador, clave del usuario) ----------

const TD_BASE = "https://api.twelvedata.com";

// Cuántos puntos semanales pedir según el rango. Twelve Data no acepta "2y": se le dice
// cuántas velas quiere uno.
const TD_OUTPUTSIZE = { "1y": 55, "2y": 108, "5y": 265, max: 5000 };

// Un símbolo puede llevar la bolsa pegada ("G2X:XETR") porque el mismo ticker cotiza en
// varias plazas y divisas distintas.
function tdSplit(symbol) {
  const [sym, mic] = String(symbol).split(":");
  return { sym, mic };
}

function tdParams(symbol, apiKey, extra = {}) {
  const { sym, mic } = tdSplit(symbol);
  const p = new URLSearchParams({ symbol: sym, apikey: apiKey, ...extra });
  if (mic) p.set("mic_code", mic);
  return p;
}

async function tdGet(path, params) {
  const res = await fetch(`${TD_BASE}/${path}?${params}`);
  const data = await res.json();
  // Los errores llegan con HTTP 200 y {code, message} dentro del cuerpo.
  if (data && data.status === "error") throw new Error(data.message || "error de Twelve Data");
  return data;
}

// El plan gratuito permite 8 créditos por minuto y cada símbolo gasta uno. Se van
// lanzando en tandas pequeñas con pausa para no chocar con el límite.
async function tdThrottled(items, fn, tamTanda = 6, pausaMs = 8000) {
  const out = [];
  for (let i = 0; i < items.length; i += tamTanda) {
    if (i > 0) await new Promise((r) => setTimeout(r, pausaMs));
    const tanda = items.slice(i, i + tamTanda);
    out.push(...(await Promise.all(tanda.map(fn))));
  }
  return out;
}

const twelveDataProvider = {
  id: "twelvedata",
  name: "Twelve Data (tu clave)",
  needsKey: true,
  note: "Con tu propia clave gratuita. 800 créditos/día: de sobra para una cartera normal.",
  signupUrl: "https://twelvedata.com/pricing",

  async quotes(symbols) {
    const apiKey = getApiKey();
    if (!apiKey) return symbols.map((s) => ({ symbol: s, price: null, currency: null, name: s, error: "falta la clave" }));

    return tdThrottled(symbols, async (symbol) => {
      try {
        // Las divisas se piden como par (EUR/USD), no como ticker de bolsa.
        const esDivisa = symbol.includes("/") || symbol === "EURUSD=X";
        const sym = symbol === "EURUSD=X" ? "EUR/USD" : symbol;
        const d = await tdGet("quote", tdParams(sym, apiKey));
        const price = parseFloat(d.close);
        return {
          symbol,
          price: Number.isNaN(price) ? null : price,
          currency: esDivisa ? "USD" : d.currency || null,
          name: d.name || symbol,
          error: null,
        };
      } catch (err) {
        return { symbol, price: null, currency: null, name: symbol, error: err.message };
      }
    });
  },

  async history(symbols, range) {
    const apiKey = getApiKey();
    if (!apiKey) return symbols.map((s) => ({ symbol: s, currency: null, points: [], error: "falta la clave" }));
    const outputsize = TD_OUTPUTSIZE[range] || TD_OUTPUTSIZE["2y"];

    return tdThrottled(symbols, async (symbol) => {
      try {
        const sym = symbol === "EURUSD=X" ? "EUR/USD" : symbol;
        const d = await tdGet("time_series", tdParams(sym, apiKey, { interval: "1week", outputsize }));
        // Vienen del más reciente al más antiguo; el resto de la app las espera al revés.
        const points = (d.values || [])
          .map((v) => ({ t: Math.floor(new Date(v.datetime).getTime() / 1000), close: parseFloat(v.close) }))
          .filter((p) => !Number.isNaN(p.t) && !Number.isNaN(p.close))
          .sort((a, b) => a.t - b.t);
        return { symbol, currency: (d.meta && d.meta.currency) || null, points, error: null };
      } catch (err) {
        return { symbol, currency: null, points: [], error: err.message };
      }
    });
  },

  async resolve(isins) {
    // symbol_search no consume créditos ni exige clave.
    return tdThrottled(
      isins,
      async (isin) => {
        try {
          const d = await tdGet("symbol_search", new URLSearchParams({ symbol: isin, outputsize: "10" }));
          const candidates = (d.data || []).map((c) => ({
            // Se guarda con la bolsa pegada: el mismo ticker existe en varias plazas.
            symbol: c.mic_code ? `${c.symbol}:${c.mic_code}` : c.symbol,
            name: c.instrument_name || c.symbol,
            exchange: c.exchange || c.mic_code,
            currency: c.currency,
          }));
          if (!candidates.length) return { isin, symbol: null, name: null, candidates: [], error: "sin coincidencias" };
          return { isin, symbol: candidates[0].symbol, name: candidates[0].name, candidates, error: null };
        } catch (err) {
          return { isin, symbol: null, name: null, candidates: [], error: err.message };
        }
      },
      8,
      2000
    );
  },
};

// ---------- Selección ----------

const PROVIDERS = { yahoo: yahooProvider, twelvedata: twelveDataProvider };

function getProviderId() {
  const id = localStorage.getItem(PROVIDER_KEY);
  return PROVIDERS[id] ? id : "yahoo";
}

function getProvider() {
  return PROVIDERS[getProviderId()];
}

function getApiKey() {
  return localStorage.getItem(APIKEY_KEY) || "";
}

function setProviderConfig(id, apiKey) {
  if (PROVIDERS[id]) localStorage.setItem(PROVIDER_KEY, id);
  if (apiKey != null) localStorage.setItem(APIKEY_KEY, apiKey.trim());
}

// Comprueba que la clave funciona antes de que el usuario se quede pensando por qué no
// carga nada.
async function testProvider(id, apiKey) {
  const prov = PROVIDERS[id];
  if (!prov) return { ok: false, msg: "proveedor desconocido" };
  if (prov.needsKey && !apiKey) return { ok: false, msg: "hace falta una clave" };
  const anterior = { id: getProviderId(), key: getApiKey() };
  try {
    setProviderConfig(id, apiKey);
    const [q] = await prov.quotes(["AAPL"]);
    if (q && q.price) return { ok: true, msg: `Conectado. AAPL: ${q.price} ${q.currency || ""}` };
    return { ok: false, msg: q && q.error ? q.error : "sin respuesta" };
  } catch (err) {
    return { ok: false, msg: err.message };
  } finally {
    setProviderConfig(anterior.id, anterior.key);
  }
}
