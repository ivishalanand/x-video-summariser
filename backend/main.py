"""fastapi entry point: serves frontend, /health, and SSE-streamed /summarize."""
from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

load_dotenv()

from pipeline import download_audio, summarize, transcribe, validate_url  # noqa: E402

FRONTEND_DIR = (Path(__file__).resolve().parent.parent / "frontend").resolve()


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("[warn] ANTHROPIC_API_KEY not set — summarize step will fail")
    yield


app = FastAPI(title="x_summariser", lifespan=lifespan)


class SummarizeRequest(BaseModel):
    url: str


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/summarize")
async def post_summarize(req: SummarizeRequest):
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
                asyncio.to_thread(download_audio, req.url, on_progress)
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

            yield _sse({"type": "progress", "step": "transcribing", "message": "Transcribing audio..."})
            transcript, duration = await asyncio.to_thread(transcribe, audio_path)
            if not duration and dl_duration:
                duration = dl_duration

            yield _sse({"type": "progress", "step": "summarizing", "message": "Summarizing..."})
            summary_text = await asyncio.to_thread(summarize, transcript)

            yield _sse(
                {
                    "type": "done",
                    "summary": summary_text,
                    "transcript": transcript,
                    "duration_seconds": duration,
                }
            )
        except ValueError as exc:
            yield _sse({"type": "error", "message": str(exc)})
        except Exception as exc:
            yield _sse({"type": "error", "message": str(exc) or "unexpected error"})
        finally:
            if audio_path is not None:
                with suppress(FileNotFoundError):
                    os.unlink(audio_path)

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    return StreamingResponse(stream(), media_type="text/event-stream", headers=headers)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")
