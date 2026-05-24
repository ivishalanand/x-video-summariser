#!/usr/bin/env python3
"""native messaging host: ensures the x_summariser uvicorn server is running."""
import json
import os
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request

VENV_UVICORN = os.path.expanduser("~/.x_summariser_venv/bin/uvicorn")
APP_DIR = os.path.expanduser("~/Desktop/Personal-projects/x_summariser/backend")
LOG_FILE = os.path.expanduser("~/.x_summariser_venv/uvicorn.log")
PORT = 8001
HEALTH_URL = f"http://127.0.0.1:{PORT}/health"
SERVER_URL = f"http://127.0.0.1:{PORT}"
HEALTH_TIMEOUT_S = 15


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    msg_len = struct.unpack("<I", raw_len)[0]
    return json.loads(sys.stdin.buffer.read(msg_len).decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def health_ok():
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=0.5) as r:
            return r.status == 200
    except (urllib.error.URLError, ConnectionError, TimeoutError):
        return False


def start_server():
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    log = open(LOG_FILE, "a")
    subprocess.Popen(
        [
            VENV_UVICORN, "main:app",
            "--host", "127.0.0.1", "--port", str(PORT),
            "--app-dir", APP_DIR,
        ],
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )


def wait_for_health(timeout=HEALTH_TIMEOUT_S):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if health_ok():
            return True
        time.sleep(0.3)
    return False


def handle(msg):
    if msg.get("action") != "ensure_server":
        return {"ok": False, "error": f"unknown action: {msg.get('action')}"}

    if health_ok():
        return {"ok": True, "url": SERVER_URL, "already_running": True}

    if not os.path.exists(VENV_UVICORN):
        return {"ok": False, "error": f"uvicorn not found at {VENV_UVICORN}"}
    if not os.path.isdir(APP_DIR):
        return {"ok": False, "error": f"backend dir not found at {APP_DIR}"}

    try:
        start_server()
    except OSError as e:
        return {"ok": False, "error": f"failed to spawn uvicorn: {e}"}

    if wait_for_health():
        return {"ok": True, "url": SERVER_URL, "started": True}
    return {"ok": False, "error": f"server did not become healthy within {HEALTH_TIMEOUT_S}s; check {LOG_FILE}"}


def main():
    msg = read_message()
    if msg is None:
        return
    send_message(handle(msg))


if __name__ == "__main__":
    main()
