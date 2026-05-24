# vid summarizer

a local web app that takes a twitter/x video URL, downloads it, transcribes the
audio with whisper, and summarizes the transcript with claude. runs entirely on
your machine; the only network calls go to twitter/x (to fetch the video) and
the anthropic API (to summarize).

## prerequisites

- python 3.11+
- [ffmpeg](https://ffmpeg.org/) — required by `yt-dlp` for audio extraction
  - mac: `brew install ffmpeg`
  - debian/ubuntu: `sudo apt install ffmpeg`
- an anthropic API key

## install

use a virtualenv so the deps don't pollute your system python:

```bash
python3.11 -m venv ~/.x_summariser_venv
source ~/.x_summariser_venv/bin/activate
pip install -r backend/requirements.txt
cp backend/.env.example backend/.env
# edit backend/.env and set ANTHROPIC_API_KEY=sk-ant-...
```

> the venv lives outside the project on purpose — claude code's preview
> sandbox can't read venvs nested inside the project tree (see [run in
> claude cowork](#run-in-claude-cowork) below). if you don't use claude
> cowork, `./.venv` works fine.

## run

```bash
cd backend
uvicorn main:app --reload --port 8000
# or, if port 8000 is taken: --port 8001
```

then open <http://localhost:8000>. paste a twitter/x video URL and hit
**summarize**.

### chrome / arc extension (on-demand)

a side-panel extension that auto-starts the backend the first time you click
it. uses chrome native messaging so the server only runs when needed.

1. **load the extension** — open `chrome://extensions` (or `arc://extensions`),
   enable *developer mode*, click *load unpacked*, select the `extension/`
   directory. copy the extension ID shown under the name (32 lowercase
   letters).
2. **install the native host** — from the repo root:
   ```bash
   ./native-host/install.sh <extension-id>
   ```
   this writes a manifest into your browser's `NativeMessagingHosts/` dir
   pointing at `native-host/host.py`. supports chrome, arc, chromium, and
   brave.
3. **use it** — open a tweet with a video, click the extension's toolbar
   icon. the side panel opens, the host script starts uvicorn detached if
   it's not already up, and the UI loads with the tweet URL pre-filled.

if something fails, check `~/.x_summariser_venv/uvicorn.log` — that's where
the detached server writes its output.

### run in claude cowork

the repo ships a [`.claude/launch.json`](.claude/launch.json) that wires the
server into claude code's preview panel. with the venv at
`~/.x_summariser_venv`, just ask claude to start the `x-summariser` server —
the preview panel will mount <http://localhost:8001/> on the right.

## usage

1. paste a twitter/x video URL (`https://x.com/<user>/status/<id>` or the
   `twitter.com` equivalent, or a `t.co` short link)
2. click **summarize**
3. watch the three step indicators light up as the video downloads, transcribes,
   and summarizes
4. read the 3–5 sentence summary; expand the transcript if you want the full
   text. copy buttons appear when you hover over either block.

## configuration

set in `backend/.env`:

| variable | default | notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | _(required)_ | your anthropic API key |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | any anthropic model id |
| `WHISPER_MODEL` | `base` | see size tradeoffs below |
| `TEMP_DIR` | `/tmp/tvsumm` | where audio files live during processing |
| `PORT` | `8000` | uvicorn port (pass to `--port`) |

### whisper model sizes

| model | speed | accuracy | RAM |
|---|---|---|---|
| `tiny` | fastest | lowest | ~1 GB |
| `base` | fast | decent | ~1 GB |
| `small` | moderate | good | ~2 GB |
| `medium` | slow | great | ~5 GB |
| `large-v3` | slowest | best | ~10 GB |

the model is downloaded automatically on first use and cached locally. `base`
handles most english videos comfortably in seconds; jump to `small` or `medium`
for accented speech, non-english audio, or noisy backgrounds.

## architecture

```
browser (vanilla HTML/CSS/JS)
    ↕ fetch + ReadableStream (SSE-format events)
fastapi backend (python)
    ├── yt-dlp          → audio download
    ├── faster-whisper  → local transcription
    └── anthropic API   → summarization
```

- `backend/main.py` — fastapi app, `/summarize` SSE endpoint, `/health`, static
  `/`.
- `backend/pipeline.py` — `download_audio`, `transcribe`, `summarize`, URL
  validation.
- `frontend/index.html` — entire UI (HTML + CSS + JS) in one file.

the whisper model is loaded once per process and reused across requests. temp
audio files are deleted after each job (success or failure).

## limits

- only public twitter/x videos with audio are supported.
- music-only or silent videos transcribe to nothing and the summary will say
  "no speech detected".
- videos > 10 minutes still work but will take longer; you'll see the
  `transcribing` step sit for a while.

## troubleshooting

- **`ffmpeg not found`** — install it (see prerequisites).
- **`couldn't download video — it may be private, deleted, or unsupported`** —
  yt-dlp couldn't fetch the URL. confirm the tweet is public and still exists.
- **`ANTHROPIC_API_KEY is not set`** — copy `.env.example` to `.env` and fill in
  the key, then restart uvicorn.
- **first request is slow** — whisper loads its model on first use; subsequent
  requests reuse the loaded model.
