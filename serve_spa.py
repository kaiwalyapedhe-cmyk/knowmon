import http.server
import os
import socketserver
import sys
import urllib.request
import urllib.error

PORT = int(os.environ.get("PORT", 3005))
BACKEND_URL = os.environ.get("BACKEND_URL", "http://127.0.0.1:8050")
BUILD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend", "build")

class SPAHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BUILD_DIR, **kwargs)

    def _proxy(self):
        target_url = f"{BACKEND_URL}{self.path}"
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else None

        req = urllib.request.Request(target_url, data=body, method=self.command)
        for key, val in self.headers.items():
            if key.lower() not in ("host", "content-length"):
                req.add_header(key, val)

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(resp.read())
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            for k, v in e.headers.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(e.read())
        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(f'{{"error": "Backend unreachable: {str(e)}"}}'.encode("utf-8"))

    def do_GET(self):
        if self.path.startswith("/api/") or self.path == "/api":
            return self._proxy()
        full_path = self.translate_path(self.path)
        if not os.path.exists(full_path) or os.path.isdir(full_path):
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/") or self.path == "/api":
            return self._proxy()
        return self.send_error(405)

    def do_PUT(self):
        if self.path.startswith("/api/") or self.path == "/api":
            return self._proxy()
        return self.send_error(405)

    def do_DELETE(self):
        if self.path.startswith("/api/") or self.path == "/api":
            return self._proxy()
        return self.send_error(405)

    def do_PATCH(self):
        if self.path.startswith("/api/") or self.path == "/api":
            return self._proxy()
        return self.send_error(405)

    def do_OPTIONS(self):
        if self.path.startswith("/api/") or self.path == "/api":
            return self._proxy()
        self.send_response(200)
        self.send_header("Allow", "GET, POST, PUT, DELETE, PATCH, OPTIONS")
        self.end_headers()

if not os.path.exists(BUILD_DIR):
    print(f"Build directory {BUILD_DIR} does not exist yet.", file=sys.stderr)
    sys.exit(1)

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", PORT), SPAHandler) as httpd:
    print(f"Serving Knowmon SPA build on http://0.0.0.0:{PORT} (Proxying /api to {BACKEND_URL})")
    httpd.serve_forever()
