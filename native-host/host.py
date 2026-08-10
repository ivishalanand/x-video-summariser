#!/usr/bin/env python3
"""Native messaging host: start/stop/inspect the x_summariser uvicorn server.

Chrome speaks to this over stdio with 4-byte little-endian length prefixes, so
stdout must carry *nothing* but framed JSON — all diagnostics go to HOST_LOG.

Actions (one request/response per process invocation):
  {"action": "status"}  -> {"ok": true, "running": bool, "pid": int|null}
  {"action": "start"}   -> {"ok": true, "running": true, "started"|"already_running": true}
  {"action": "stop"}    -> {"ok": true, "running": false, "stopped": bool}
"""
from __future__ import annotations

import json
import os
import signal
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PORT = 47291
HEALTH_URL = f"http://127.0.0.1:{PORT}/health"

PROJECT_DIR = Path(__file__).resolve().parent.parent
BACKEND_DIR = PROJECT_DIR / "backend"
VENV_PY = Path.home() / ".x_summariser_venv" / "bin" / "python3"

STATE_DIR = Path.home() / ".x_summariser"
PID_FILE = STATE_DIR / "uvicorn.pid"
HOST_LOG = STATE_DIR / "host.log"
UVICORN_LOG = Path.home() / "Library" / "Logs" / "x_summariser.log"

# Arc/Chrome hand the host a nearly empty PATH; yt-dlp shells out to ffmpeg, so
# the spawned server needs homebrew on PATH or downloads die at audio extraction.
SPAWN_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

START_TIMEOUT_S = 40
STOP_TIMEOUT_S = 10


# ─── protocol ────────────────────────────────────────────────────────────────


def read_message() -> dict | None:
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (msg_len,) = struct.unpack("<I", raw_len)
    return json.loads(sys.stdin.buffer.read(msg_len).decode("utf-8"))


def send_message(obj: dict) -> None:
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def log(msg: str) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with HOST_LOG.open("a") as fh:
            fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except OSError:
        pass  # logging must never break the protocol


# ─── server inspection ───────────────────────────────────────────────────────


def health_ok(timeout: float = 0.6) -> bool:
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=timeout) as r:
            return r.status == 200
    except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
        return False


def cmdline(pid: int) -> str:
    try:
        out = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            capture_output=True, text=True, timeout=5,
        )
        return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def is_ours(pid: int) -> bool:
    """Only ever signal a process we recognise as this project's uvicorn."""
    cmd = cmdline(pid)
    if not cmd:
        return False
    return "uvicorn" in cmd and (str(VENV_PY.parent) in cmd or "main:app" in cmd)


def listener_pids() -> list[int]:
    try:
        out = subprocess.run(
            ["lsof", "-ti", f"tcp:{PORT}", "-sTCP:LISTEN"],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    return [int(x) for x in out.stdout.split() if x.strip().isdigit()]


def recorded_pid() -> int | None:
    try:
        pid = int(PID_FILE.read_text().strip())
    except (OSError, ValueError):
        return None
    try:
        os.kill(pid, 0)
    except OSError:
        return None
    return pid


def server_pid() -> int | None:
    pid = recorded_pid()
    if pid is not None and is_ours(pid):
        return pid
    for candidate in listener_pids():
        if is_ours(candidate):
            return candidate
    return None


# ─── start ───────────────────────────────────────────────────────────────────


def spawn() -> int:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    UVICORN_LOG.parent.mkdir(parents=True, exist_ok=True)
    log_fh = UVICORN_LOG.open("a")

    env = dict(os.environ)
    env["PATH"] = SPAWN_PATH
    env["HOME"] = str(Path.home())

    # cwd must be BACKEND_DIR: main.py calls load_dotenv(), which walks up from
    # the *working directory* to find backend/.env — --app-dir alone won't do it,
    # and a missing .env means no ANTHROPIC_API_KEY at summarize time.
    proc = subprocess.Popen(
        [str(VENV_PY), "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=str(BACKEND_DIR),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=log_fh,
        stderr=subprocess.STDOUT,
        start_new_session=True,  # survives this short-lived host process
    )
    PID_FILE.write_text(str(proc.pid))
    return proc.pid


def wait_for(predicate, timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.3)
    return predicate()


def do_start() -> dict:
    if health_ok():
        return {"ok": True, "running": True, "already_running": True, "pid": server_pid()}

    if not VENV_PY.exists():
        return {"ok": False, "error": f"python not found at {VENV_PY} — create the venv (see README)"}
    if not BACKEND_DIR.is_dir():
        return {"ok": False, "error": f"backend dir not found at {BACKEND_DIR}"}
    if not (BACKEND_DIR / ".env").exists():
        return {"ok": False, "error": "backend/.env is missing — copy .env.example and set ANTHROPIC_API_KEY"}

    try:
        pid = spawn()
    except OSError as exc:
        log(f"spawn failed: {exc}")
        return {"ok": False, "error": f"failed to spawn uvicorn: {exc}"}

    log(f"spawned pid={pid}")
    if wait_for(health_ok, START_TIMEOUT_S):
        return {"ok": True, "running": True, "started": True, "pid": pid}
    return {
        "ok": False,
        "running": False,
        "error": f"server didn't come up within {START_TIMEOUT_S}s — see {UVICORN_LOG}",
    }


# ─── stop ────────────────────────────────────────────────────────────────────


def signal_group(pid: int, sig: int) -> bool:
    """Signal the whole process group — uvicorn's reloader keeps a child."""
    try:
        pgid = os.getpgid(pid)
    except OSError:
        return False
    if pgid == os.getpgid(0):  # never take ourselves (or the browser) down
        log(f"refusing to signal own process group {pgid}")
        return False
    try:
        os.killpg(pgid, sig)
        return True
    except OSError as exc:
        log(f"killpg({pgid}, {sig}) failed: {exc}")
        return False


def do_stop() -> dict:
    pid = server_pid()
    if pid is None:
        PID_FILE.unlink(missing_ok=True)
        if health_ok():
            return {"ok": False, "running": True,
                    "error": f"something is serving port {PORT} but it isn't this project's uvicorn"}
        return {"ok": True, "running": False, "stopped": False, "already_stopped": True}

    signal_group(pid, signal.SIGTERM)
    if not wait_for(lambda: not health_ok(0.3) and server_pid() is None, STOP_TIMEOUT_S):
        log(f"SIGTERM timed out for pid={pid}, escalating")
        signal_group(pid, signal.SIGKILL)
        wait_for(lambda: not health_ok(0.3), 3)

    PID_FILE.unlink(missing_ok=True)
    if health_ok(0.3):
        return {"ok": False, "running": True, "error": f"server on port {PORT} is still responding"}
    log(f"stopped pid={pid}")
    return {"ok": True, "running": False, "stopped": True}


# ─── dispatch ────────────────────────────────────────────────────────────────


def handle(msg: dict) -> dict:
    action = msg.get("action")
    if action == "status":
        running = health_ok()
        return {"ok": True, "running": running, "pid": server_pid() if running else None}
    if action == "start":
        return do_start()
    if action == "stop":
        return do_stop()
    return {"ok": False, "error": f"unknown action: {action!r}"}


def main() -> None:
    msg = read_message()
    if msg is None:
        return
    try:
        resp = handle(msg)
    except Exception as exc:  # never leave the extension hanging
        log(f"unhandled: {exc!r}")
        resp = {"ok": False, "error": f"native host error: {exc}"}
    send_message(resp)


if __name__ == "__main__":
    main()
