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
SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search?q={query}&quotesCount=1"

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


def resolve_isin(isin: str) -> dict:
    if isin in _resolve_cache:
        return _resolve_cache[isin]
    url = SEARCH_URL.format(query=urllib.parse.quote(isin))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        quotes = data.get("quotes") or []
        if not quotes:
            result = {"isin": isin, "symbol": None, "name": None, "error": "sin coincidencias"}
        else:
            q = quotes[0]
            result = {
                "isin": isin,
                "symbol": q.get("symbol"),
                "name": q.get("shortname") or q.get("longname") or q.get("symbol"),
                "error": None,
            }
    except Exception as exc:  # noqa: BLE001
        result = {"isin": isin, "symbol": None, "name": None, "error": str(exc)}
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
