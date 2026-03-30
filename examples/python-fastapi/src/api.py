"""Minimal HTTP API using only the standard library (no framework dependency)."""

import json
import os
import signal
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = int(os.environ.get("PORT", "8000"))
ENV_NAME = os.environ.get("ENV_NAME", "unknown")

tasks: list[dict] = []


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"status": "ok", "env": ENV_NAME})
        elif self.path == "/api/tasks":
            self._json(200, {"tasks": tasks, "count": len(tasks)})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/api/tasks":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            task = {"id": len(tasks) + 1, "name": body.get("name", "unnamed")}
            tasks.append(task)
            self._json(201, task)
        else:
            self._json(404, {"error": "not found"})

    def _json(self, status: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"[api] {args[0]}")


server = HTTPServer(("", PORT), Handler)


def shutdown(signum, frame):
    print("API shutting down...")
    server.shutdown()
    sys.exit(0)


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)

print(f"API listening on port {PORT} (env: {ENV_NAME})")
server.serve_forever()
