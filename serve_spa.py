import http.server
import os
import socketserver
import sys

PORT = int(os.environ.get("PORT", 3001))
BUILD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend", "build")

class SPAHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BUILD_DIR, **kwargs)

    def do_GET(self):
        full_path = self.translate_path(self.path)
        if not os.path.exists(full_path) or os.path.isdir(full_path):
            self.path = "/index.html"
        return super().do_GET()

if not os.path.exists(BUILD_DIR):
    print(f"Build directory {BUILD_DIR} does not exist yet.", file=sys.stderr)
    sys.exit(1)

# Allow port reuse
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", PORT), SPAHandler) as httpd:
    print(f"Serving SPA build on http://0.0.0.0:{PORT}")
    httpd.serve_forever()
