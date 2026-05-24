"""processing pipeline: download audio, transcribe, summarize."""
from __future__ import annotations

import os
import re
import uuid
from pathlib import Path
from typing import Callable, Tuple

from anthropic import Anthropic
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


def transcribe(audio_path: Path) -> Tuple[str, float]:
    model = _get_whisper()
    segments, info = model.transcribe(str(audio_path), beam_size=5)
    text = " ".join(seg.text.strip() for seg in segments).strip()
    duration = float(info.duration or 0.0)
    return text, duration


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
