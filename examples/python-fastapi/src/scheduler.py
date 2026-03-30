"""Background scheduler that creates tasks via the API on a timer."""

import json
import os
import signal
import sys
import time
import urllib.request

API_URL = os.environ.get("API_URL", "http://localhost:8000")
ENV_NAME = os.environ.get("ENV_NAME", "unknown")

running = True


def shutdown(signum, frame):
    global running
    print("Scheduler shutting down...")
    running = False


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)

print(f"Scheduler started (env: {ENV_NAME}), posting tasks to {API_URL}")

counter = 0
while running:
    counter += 1
    try:
        data = json.dumps({"name": f"scheduled-task-{counter}"}).encode()
        req = urllib.request.Request(
            f"{API_URL}/api/tasks",
            data=data,
            headers={"Content-Type": "application/json"},
        )
        resp = urllib.request.urlopen(req)
        result = json.loads(resp.read())
        print(f"[{time.strftime('%H:%M:%S')}] Created task #{result['id']}: {result['name']}")
    except Exception as e:
        print(f"[{time.strftime('%H:%M:%S')}] Failed: {e}")

    for _ in range(50):  # 5 seconds in 100ms increments (allows fast shutdown)
        if not running:
            break
        time.sleep(0.1)

print("Scheduler stopped.")
