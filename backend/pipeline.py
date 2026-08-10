"""processing pipeline: download audio, transcribe, summarize."""
from __future__ import annotations

import os
import re
import uuid
from pathlib import Path
from typing import Callable, Tuple

from anthropic import Anthropic, AsyncAnthropic
from faster_whisper import WhisperModel
from yt_dlp import YoutubeDL

_URL_PATTERNS = [
    re.compile(r"^https://(?:www\.)?x\.com/[^/]+/status/\d+(?:[/?].*)?$", re.IGNORECASE),
    re.compile(r"^https://(?:www\.)?twitter\.com/[^/]+/status/\d+(?:[/?].*)?$", re.IGNORECASE),
    re.compile(r"^https://t\.co/[A-Za-z0-9_-]+$", re.IGNORECASE),
]

_TEMP_DIR = Path(os.environ.get("TEMP_DIR", "/tmp/tvsumm"))
_WHISPER_MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")
_ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")

_whisper: WhisperModel | None = None
_anthropic: Anthropic | None = None
_async_anthropic: AsyncAnthropic | None = None


def validate_url(url: str) -> None:
    if not isinstance(url, str) or not url.strip():
        raise ValueError("URL is required")
    for pat in _URL_PATTERNS:
        if pat.match(url.strip()):
            return
    raise ValueError("URL must be a twitter/x status URL or t.co short link")


def _get_whisper() -> WhisperModel:
    global _whisper
    if _whisper is None:
        _whisper = WhisperModel(_WHISPER_MODEL_SIZE, device="cpu", compute_type="int8")
    return _whisper


def _get_anthropic() -> Anthropic:
    global _anthropic
    if _anthropic is None:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise RuntimeError("ANTHROPIC_API_KEY is not set")
        _anthropic = Anthropic()
    return _anthropic


def _get_async_anthropic() -> AsyncAnthropic:
    global _async_anthropic
    if _async_anthropic is None:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise RuntimeError("ANTHROPIC_API_KEY is not set")
        _async_anthropic = AsyncAnthropic()
    return _async_anthropic


def download_audio(
    url: str,
    progress_hook: Callable[[dict], None] | None = None,
    postprocess_hook: Callable[[dict], None] | None = None,
) -> Tuple[Path, float | None]:
    """download audio; return (mp3 path, duration in seconds if known)."""
    validate_url(url)
    _TEMP_DIR.mkdir(parents=True, exist_ok=True)
    job_id = uuid.uuid4().hex
    out_template = str(_TEMP_DIR / f"{job_id}.%(ext)s")
    options = {
        "format": "bestaudio/best",
        "outtmpl": out_template,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ],
    }
    if progress_hook is not None:
        options["progress_hooks"] = [progress_hook]
    if postprocess_hook is not None:
        options["postprocessor_hooks"] = [postprocess_hook]
    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
    except Exception as exc:
        raise RuntimeError(
            "couldn't download video — it may be private, deleted, or unsupported"
        ) from exc
    out_path = _TEMP_DIR / f"{job_id}.mp3"
    if not out_path.exists():
        raise RuntimeError("audio extraction failed — is ffmpeg installed?")
    raw_duration = info.get("duration") if isinstance(info, dict) else None
    duration = float(raw_duration) if raw_duration else None
    return out_path, duration


def transcribe(
    audio_path: Path,
    progress_hook: Callable[[dict], None] | None = None,
) -> Tuple[str, float]:
    model = _get_whisper()
    segments, info = model.transcribe(str(audio_path), beam_size=5)
    duration = float(info.duration or 0.0)
    texts: list[str] = []
    for seg in segments:
        texts.append(seg.text.strip())
        if progress_hook is not None:
            progress_hook(
                {
                    "current": float(seg.end),
                    "total": duration,
                    "percent": (float(seg.end) / duration * 100) if duration else None,
                }
            )
    return " ".join(texts).strip(), duration


_SUMMARIZER_SYSTEM = (
    "You are a concise summarizer. Given a video transcript, "
    "return a clear 3-5 sentence summary capturing the main points. "
    "Be direct, no fluff."
)


def summarize(transcript: str) -> str:
    if not transcript:
        return "no speech detected"
    client = _get_anthropic()
    msg = client.messages.create(
        model=_ANTHROPIC_MODEL,
        max_tokens=500,
        system=_SUMMARIZER_SYSTEM,
        messages=[{"role": "user", "content": f"transcript:\n\n{transcript}"}],
    )
    parts = [b.text for b in msg.content if getattr(b, "type", None) == "text"]
    return "\n".join(parts).strip()


_CHAT_SYSTEM_TEMPLATE = (
    "You are a helpful assistant answering questions about a video the user just "
    "watched. Be concise and direct. Quote from the transcript when it sharpens the "
    "answer. If something isn't in the transcript, say so plainly. "
    "Format your responses in markdown — use lists, bold, headings, and code blocks "
    "where they aid clarity.\n\n"
    "<transcript>\n{transcript}\n</transcript>"
)


async def chat_stream(transcript: str, messages: list[dict]):
    """yield assistant text tokens for a chat turn over a transcript."""
    client = _get_async_anthropic()
    system = [
        {
            "type": "text",
            "text": _CHAT_SYSTEM_TEMPLATE.format(transcript=transcript or "(no transcript available)"),
            "cache_control": {"type": "ephemeral"},
        }
    ]
    async with client.messages.stream(
        model=_ANTHROPIC_MODEL,
        max_tokens=1024,
        system=system,
        messages=messages,
    ) as stream:
        async for text in stream.text_stream:
            yield text
