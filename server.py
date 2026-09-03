"""Servidor local para el tracker de inversiones.

Sirve los archivos estaticos de public/ y expone /api/quotes como proxy
hacia Yahoo Finance (evita el bloqueo CORS que ocurriria llamando
directamente desde el navegador).
"""
import json
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

PORT = 8765
PUBLIC_DIR = Path(__file__).parent / "public"
QUOTE_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search?q={query}&quotesCount=10"
HISTORY_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range={range}&interval={interval}"

ALLOWED_RANGES = {"6mo", "1y", "2y", "5y", "10y", "max"}
ALLOWED_INTERVALS = {"1d", "1wk", "1mo"}

_resolve_cache: dict[str, dict] = {}


def fetch_quote(symbol: str) -> dict:
    url = QUOTE_URL.format(symbol=urllib.parse.quote(symbol))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        meta = data["chart"]["result"][0]["meta"]
        return {
            "symbol": symbol,
            "price": meta.get("regularMarketPrice"),
            "currency": meta.get("currency"),
            "name": meta.get("shortName") or meta.get("longName") or symbol,
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001 - queremos reportar cualquier fallo al front
        return {"symbol": symbol, "price": None, "currency": None, "name": symbol, "error": str(exc)}


def fetch_history(args: tuple[str, str, str]) -> dict:
    symbol, range_, interval = args
    url = HISTORY_URL.format(symbol=urllib.parse.quote(symbol), range=range_, interval=interval)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        result = data["chart"]["result"][0]
        timestamps = result.get("timestamp") or []
        closes = result["indicators"]["quote"][0].get("close") or []
        meta = result["meta"]
        points = [
            {"t": ts, "close": close}
            for ts, close in zip(timestamps, closes)
            if close is not None
        ]
        return {"symbol": symbol, "currency": meta.get("currency"), "points": points, "error": None}
    except Exception as exc:  # noqa: BLE001
        return {"symbol": symbol, "currency": None, "points": [], "error": str(exc)}


def resolve_isin(isin: str) -> dict:
    """Devuelve todos los listados que Yahoo asocia al ISIN.

    Se entregan como lista de candidatos (no solo el primero) porque el mismo fondo
    cotiza en varias plazas y divisas, y porque la busqueda a veces cuela un
    instrumento parecido pero distinto: quien llama decide cual encaja comparando
    el precio con el de las operaciones reales.
    """
    if isin in _resolve_cache:
        return _resolve_cache[isin]
    url = SEARCH_URL.format(query=urllib.parse.quote(isin))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        quotes = data.get("quotes") or []
        candidates = [
            {
                "symbol": q.get("symbol"),
                "name": q.get("shortname") or q.get("longname") or q.get("symbol"),
                "exchange": q.get("exchDisp") or q.get("exchange"),
            }
            for q in quotes
            if q.get("symbol")
        ]
        if not candidates:
            result = {"isin": isin, "symbol": None, "name": None, "candidates": [], "error": "sin coincidencias"}
        else:
            result = {
                "isin": isin,
                "symbol": candidates[0]["symbol"],
                "name": candidates[0]["name"],
                "candidates": candidates,
                "error": None,
            }
    except Exception as exc:  # noqa: BLE001
        result = {"isin": isin, "symbol": None, "name": None, "candidates": [], "error": str(exc)}
    _resolve_cache[isin] = result
    return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # silencia el log por consola

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/quotes":
            qs = parse_qs(parsed.query)
            symbols = [s.strip().upper() for s in qs.get("symbols", [""])[0].split(",") if s.strip()]
            if not symbols:
                self._send_json(400, {"error": "falta el parametro symbols"})
                return
            with ThreadPoolExecutor(max_workers=min(8, len(symbols))) as pool:
                results = list(pool.map(fetch_quote, symbols))
            self._send_json(200, results)
            return

        if parsed.path == "/api/history":
            qs = parse_qs(parsed.query)
            symbols = [s.strip().upper() for s in qs.get("symbols", [""])[0].split(",") if s.strip()]
            range_ = qs.get("range", ["2y"])[0]
            interval = qs.get("interval", ["1wk"])[0]
            if range_ not in ALLOWED_RANGES:
                range_ = "2y"
            if interval not in ALLOWED_INTERVALS:
                interval = "1wk"
            if not symbols:
                self._send_json(400, {"error": "falta el parametro symbols"})
                return
            args = [(s, range_, interval) for s in symbols]
            with ThreadPoolExecutor(max_workers=min(8, len(args))) as pool:
                results = list(pool.map(fetch_history, args))
            self._send_json(200, results)
            return

        if parsed.path == "/api/resolve":
            qs = parse_qs(parsed.query)
            isins = [s.strip().upper() for s in qs.get("isins", [""])[0].split(",") if s.strip()]
            if not isins:
                self._send_json(400, {"error": "falta el parametro isins"})
                return
            with ThreadPoolExecutor(max_workers=min(8, len(isins))) as pool:
                results = list(pool.map(resolve_isin, isins))
            self._send_json(200, results)
            return

        self._serve_static(parsed.path)

    def _serve_static(self, path: str):
        if path == "/":
            path = "/index.html"
        file_path = (PUBLIC_DIR / path.lstrip("/")).resolve()

        if PUBLIC_DIR not in file_path.parents and file_path != PUBLIC_DIR:
            self.send_error(403)
            return
        if not file_path.is_file():
            self.send_error(404)
            return

        content_types = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
        }
        ctype = content_types.get(file_path.suffix, "application/octet-stream")
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Tracker de inversiones corriendo en http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
