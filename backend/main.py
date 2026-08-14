"""fastapi entry point: serves frontend, /health, and SSE-streamed /summarize."""
from __future__ import annotations

import asyncio
import json
import os
import threading
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

load_dotenv()

from pipeline import (  # noqa: E402
    Cancelled,
    chat_stream,
    download_audio,
    summarize,
    transcribe,
    validate_url,
)

FRONTEND_DIR = (Path(__file__).resolve().parent.parent / "frontend").resolve()


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("[warn] ANTHROPIC_API_KEY not set — summarize step will fail")
    yield


app = FastAPI(title="x_summariser", lifespan=lifespan)

# Only transcription is CPU-bound; downloads can run in parallel so we
# serialise only the Whisper step with a semaphore.
_transcribe_sem = asyncio.Semaphore(1)

# Stopping a job has to reach the worker threads: a thread can't be killed, so
# yt-dlp and Whisper poll this flag and raise Cancelled. Keyed by the job id the
# sidebar generates. Closing the tab trips the same flag via the finally below,
# so a refresh mid-transcribe no longer leaves Whisper running.
_cancels: dict[str, threading.Event] = {}

from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])


class SummarizeRequest(BaseModel):
    url: str
    job_id: str | None = None


class CancelRequest(BaseModel):
    job_id: str


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    transcript: str
    messages: list[ChatMessage]


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/cancel")
async def post_cancel(req: CancelRequest) -> dict:
    ev = _cancels.get(req.job_id)
    if ev is None:
        return {"ok": False, "reason": "unknown or already finished job"}
    ev.set()
    return {"ok": True}


@app.post("/summarize")
async def post_summarize(req: SummarizeRequest):
    job_id = req.job_id
    cancel = threading.Event()
    if job_id:
        _cancels[job_id] = cancel
    should_cancel = cancel.is_set

    async def stream():
        audio_path: Path | None = None
        try:
            validate_url(req.url)

            yield _sse({"type": "progress", "step": "downloading", "message": "Fetching video..."})

            loop = asyncio.get_running_loop()
            progress_queue: asyncio.Queue[dict] = asyncio.Queue()
            last_emit = 0.0

            def on_progress(d: dict) -> None:
                # called on the yt-dlp worker thread
                nonlocal last_emit
                status = d.get("status")
                if status == "downloading":
                    now = loop.time()
                    if now - last_emit < 0.15:
                        return
                    last_emit = now
                    downloaded = d.get("downloaded_bytes") or 0
                    total = d.get("total_bytes") or d.get("total_bytes_estimate")
                    speed = d.get("speed")
                    percent = (downloaded / total * 100) if total else None
                    loop.call_soon_threadsafe(
                        progress_queue.put_nowait,
                        {
                            "type": "download_progress",
                            "downloaded": downloaded,
                            "total": total,
                            "percent": percent,
                            "speed": speed,
                        },
                    )
                elif status == "finished":
                    loop.call_soon_threadsafe(
                        progress_queue.put_nowait,
                        {"type": "download_progress", "percent": 100, "phase": "extracting"},
                    )

            download_task = asyncio.create_task(
                asyncio.to_thread(download_audio, req.url, on_progress, None, should_cancel)
            )
            while not download_task.done():
                get_task = asyncio.create_task(progress_queue.get())
                done, _ = await asyncio.wait(
                    {download_task, get_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if get_task in done:
                    yield _sse(get_task.result())
                else:
                    get_task.cancel()
                    with suppress(asyncio.CancelledError):
                        await get_task
            while not progress_queue.empty():
                yield _sse(progress_queue.get_nowait())
            audio_path, dl_duration = download_task.result()

            if dl_duration and dl_duration > 600:
                yield _sse(
                    {
                        "type": "warn",
                        "message": "video is over 10 minutes — this may take a while",
                    }
                )

            # Signal transcribing step (may queue briefly if another video is
            # already transcribing — semaphore keeps Whisper single-threaded).
            yield _sse({"type": "progress", "step": "transcribing", "message": "Transcribing audio..."})

            async with _transcribe_sem:
                transcribe_queue: asyncio.Queue[dict] = asyncio.Queue()
                last_tx_emit = 0.0

                def on_transcribe(d: dict) -> None:
                    nonlocal last_tx_emit
                    now = loop.time()
                    if now - last_tx_emit < 0.15:
                        return
                    last_tx_emit = now
                    loop.call_soon_threadsafe(
                        transcribe_queue.put_nowait,
                        {
                            "type": "transcribe_progress",
                            "current": d.get("current"),
                            "total": d.get("total"),
                            "percent": d.get("percent"),
                        },
                    )

                transcribe_task = asyncio.create_task(
                    asyncio.to_thread(transcribe, audio_path, on_transcribe, should_cancel)
                )
                while not transcribe_task.done():
                    get_task = asyncio.create_task(transcribe_queue.get())
                    done, _ = await asyncio.wait(
                        {transcribe_task, get_task},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if get_task in done:
                        yield _sse(get_task.result())
                    else:
                        get_task.cancel()
                        with suppress(asyncio.CancelledError):
                            await get_task
                while not transcribe_queue.empty():
                    yield _sse(transcribe_queue.get_nowait())
                transcript, duration = transcribe_task.result()

            if not duration and dl_duration:
                duration = dl_duration

            yield _sse({"type": "progress", "step": "summarizing", "message": "Summarizing..."})
            if should_cancel():
                raise Cancelled()
            summary_text = await asyncio.to_thread(summarize, transcript)

            yield _sse(
                {
                    "type": "done",
                    "summary": summary_text,
                    "transcript": transcript,
                    "duration_seconds": duration,
                }
            )
        except Cancelled:
            # the sidebar already dropped the card; this is just a clean exit
            with suppress(Exception):
                yield _sse({"type": "cancelled"})
        except ValueError as exc:
            yield _sse({"type": "error", "message": str(exc)})
        except Exception as exc:
            yield _sse({"type": "error", "message": str(exc) or "unexpected error"})
        finally:
            # covers every exit, including the client closing the tab: whatever
            # is still on a worker thread stops at its next checkpoint
            cancel.set()
            if job_id:
                _cancels.pop(job_id, None)
            if audio_path is not None:
                with suppress(FileNotFoundError):
                    os.unlink(audio_path)

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    return StreamingResponse(stream(), media_type="text/event-stream", headers=headers)


@app.post("/chat")
async def post_chat(req: ChatRequest):
    async def event_stream():
        try:
            messages = [m.model_dump() for m in req.messages]
            if not messages or messages[-1]["role"] != "user":
                yield _sse({"type": "error", "message": "last message must be from user"})
                return
            async for chunk in chat_stream(req.transcript, messages):
                yield _sse({"type": "token", "text": chunk})
            yield _sse({"type": "done"})
        except Exception as exc:
            yield _sse({"type": "error", "message": str(exc) or "unexpected error"})

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")
