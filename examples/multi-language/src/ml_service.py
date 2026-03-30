"""Simulated ML inference service. Returns fake predictions to demonstrate
cross-language service communication via spawntree."""

import json
import os
import signal
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = int(os.environ.get("PORT", "5000"))
ENV_NAME = os.environ.get("ENV_NAME", "unknown")
MODEL_NAME = os.environ.get("MODEL_NAME", "default-model")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"status": "ok", "model": MODEL_NAME, "env": ENV_NAME})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/predict":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            text = body.get("text", "")

            # Fake prediction
            score = len(text) % 10 / 10.0
            label = "positive" if score > 0.5 else "negative"

            self._json(200, {
                "model": MODEL_NAME,
                "text": text[:50],
                "prediction": {"label": label, "score": round(score, 2)},
                "env": ENV_NAME,
            })
        else:
            self._json(404, {"error": "not found"})

    def _json(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"[ml-service] {args[0]}")


server = HTTPServer(("", PORT), Handler)


def shutdown(signum, frame):
    print(f"ML service ({MODEL_NAME}) shutting down...")
    server.shutdown()
    sys.exit(0)


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)

print(f"ML service listening on port {PORT} (model: {MODEL_NAME}, env: {ENV_NAME})")
server.serve_forever()
