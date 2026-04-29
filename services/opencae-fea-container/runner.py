from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import subprocess


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "solver": "calculix", "ccx": self._ccx_version()})
            return
        self._json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/solve":
            self._json(404, {"error": "Not found"})
            return
        length = int(self.headers.get("content-length", "0") or "0")
        body = self.rfile.read(length).decode("utf-8") if length else "{}"
        payload = json.loads(body)
        self._json(202, {
            "status": "accepted",
            "solver": "calculix",
            "message": "CalculiX container contract is ready; meshing and CCX execution are wired in a later solver adapter.",
            "request": payload
        })

    def log_message(self, format, *args):
        return

    def _json(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _ccx_version(self):
        try:
            result = subprocess.run(["ccx", "-v"], check=False, capture_output=True, text=True, timeout=3)
            return (result.stdout or result.stderr).strip().splitlines()[0]
        except Exception:
            return "unavailable"


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
