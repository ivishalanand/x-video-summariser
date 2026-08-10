# vid summarizer

a local web app + chrome extension that takes a twitter/x video URL, downloads
it, transcribes the audio with whisper, and summarizes the transcript with
claude. runs entirely on your machine; the only network calls go to twitter/x
(to fetch the video) and the anthropic API (to summarize).

## port

**the backend runs on `47291` — deliberately weird so it never conflicts with
anything else you're running.** don't change it unless you also update
`extension/content.js` (`const BACKEND = 'http://localhost:47291'`).

## prerequisites

- python 3.11+
- [ffmpeg](https://ffmpeg.org/) — required by `yt-dlp` for audio extraction
  - mac: `brew install ffmpeg`
  - debian/ubuntu: `sudo apt install ffmpeg`
- an anthropic API key
- google chrome (for the extension)

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
> sandbox can't read venvs nested inside the project tree. if you don't use
> claude cowork, `./.venv` works fine.

generate the extension icons once:

```bash
cd extension && python3 generate_icons.py && cd ..
```

## run

**option A — from the sidebar (no terminal):**

the extension sidebar has a server bar at the top: a red/green dot, the current
state, and a **launch** / **stop** button. clicking **launch** starts the
backend; clicking **stop** shuts it down. if you hit a video before the server
is up, the card shows **launch server & retry** — one click starts the backend
and re-runs that video, no need to paste the url again.

this needs the native messaging host registered once (chrome extensions can't
spawn processes on their own):

```bash
bash native-host/install.sh
```

it figures out your extension id from the `extension/` path and writes the host
manifest for arc, chrome, chromium and brave. reload the extension afterwards.

**option B — manual (terminal stays open):**

```bash
source ~/.x_summariser_venv/bin/activate
cd backend
uvicorn main:app --reload --port 47291
```

**option C — launchd (auto-start at macOS login, no terminal needed):**

```bash
bash scripts/install_launchd.sh
```

this installs a launchd agent that starts the backend automatically every time
you log in. it also starts it immediately so you don't need to restart. logs go
to `~/Library/Logs/x_summariser.log`.

to stop it temporarily:
```bash
launchctl unload ~/Library/LaunchAgents/com.x_summariser.backend.plist
```

to uninstall completely:
```bash
launchctl unload ~/Library/LaunchAgents/com.x_summariser.backend.plist
rm ~/Library/LaunchAgents/com.x_summariser.backend.plist
```

the web UI is also available at <http://localhost:47291> if you want to use it
without the extension.

## chrome extension

1. open `chrome://extensions`
2. enable **developer mode** (toggle, top-right)
3. click **load unpacked** → select the `extension/` folder in this repo
4. run `bash native-host/install.sh` so the sidebar's launch/stop buttons work
5. navigate to `x.com` — click the ⚡ icon in the chrome toolbar to toggle
   the sidebar

the sidebar auto-fills the URL if you're already on a tweet page. the server bar
at the top starts the backend for you — no terminal needed.

> **moving the repo breaks the launch button.** an unpacked extension's id is
> derived from its absolute path, and the host manifest pins that id. if you move
> the project, re-run `bash native-host/install.sh`.

## usage

1. paste a twitter/x video URL (`https://x.com/<user>/status/<id>` or the
   `twitter.com` equivalent, or a `t.co` short link)
2. click **go** (extension) or **summarize** (web UI)
3. watch the three step indicators: downloading → transcribing → summarizing
4. read the summary; click the **transcript** tab to see the full text. both
   have a **copy** button.
5. ask follow-up questions in the **chat** section below

## configuration

set in `backend/.env`:

| variable | default | notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | _(required)_ | your anthropic API key |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | any anthropic model id |
| `WHISPER_MODEL` | `base` | see size tradeoffs below |
| `TEMP_DIR` | `/tmp/tvsumm` | where audio files live during processing |
| `PORT` | `47291` | hardcoded weird port — also hardcoded in `extension/content.js` |

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
chrome extension (content.js — shadow DOM sidebar on x.com)
    ↕ fetch + ReadableStream (SSE)
fastapi backend — localhost:47291
    ├── yt-dlp          → audio download
    ├── faster-whisper  → local transcription
    └── anthropic API   → summarization
```

- `backend/main.py` — fastapi app, `/summarize` and `/chat` SSE endpoints,
  `/health`, static `/`.
- `backend/pipeline.py` — `download_audio`, `transcribe`, `summarize`, URL
  validation.
- `frontend/index.html` — standalone web UI (same features as the extension).
- `extension/content.js` — full sidebar injected into x.com via shadow DOM.
- `extension/manifest.json` — chrome extension manifest v3.
- `extension/background.js` — toolbar toggle + relays server start/stop from the
  content script to the native host (content scripts can't do native messaging).
- `native-host/host.py` — starts/stops uvicorn on request. spawns it detached
  with `cwd=backend/` (so `load_dotenv()` finds `.env`) and homebrew on `PATH`
  (so `yt-dlp` finds `ffmpeg`).
- `native-host/install.sh` — registers the host with arc/chrome/chromium/brave.

the whisper model is loaded once per process and reused across requests. temp
audio files are deleted after each job (success or failure).

## limits

- only public twitter/x videos with audio are supported.
- music-only or silent videos transcribe to nothing and the summary will say
  "no speech detected".
- videos > 10 minutes still work but will take longer; you'll see the
  `transcribing` step sit for a while.

## troubleshooting

- **sidebar doesn't open** — make sure the backend is running on port `47291`
  first. the extension talks to `http://localhost:47291`.
- **`ffmpeg not found`** — install it (see prerequisites).
- **`couldn't download video`** — yt-dlp couldn't fetch the URL. confirm the
  tweet is public and still exists.
- **`ANTHROPIC_API_KEY is not set`** — copy `.env.example` to `.env` and fill
  in the key, then restart uvicorn.
- **first request is slow** — whisper loads its model on first use; subsequent
  requests reuse the loaded model.
- **port conflict** — if something else somehow grabbed `47291`, change it in
  both `backend/.env` and `extension/content.js` (`const BACKEND = …`), then
  reload the extension in `chrome://extensions`.
- **sidebar says "native host not installed"** — run `bash native-host/install.sh`,
  then reload the extension at `arc://extensions` / `chrome://extensions`. if it
  still fails, check the id printed by the script against the one on the
  extensions page and re-run with it: `bash native-host/install.sh <id>`.
- **launch button spins then errors** — the backend failed to boot. the message
  points at `~/Library/Logs/x_summariser.log`; `~/.x_summariser/host.log` has the
  native host's own trace.
- **summaries fail right after a sidebar launch** — the server starts fine
  without an API key and only warns. check the uvicorn log for
  `ANTHROPIC_API_KEY not set` and fill in `backend/.env`.
- **launchd agent not starting** — check `~/Library/Logs/x_summariser.log` for
  errors. common causes: venv missing (re-run `pip install -r backend/requirements.txt`),
  `.env` missing (re-copy from `.env.example`), or port already in use.
- **check if the launchd agent is running** — `launchctl list com.x_summariser.backend`.
  a pid in the first column means it's running.
