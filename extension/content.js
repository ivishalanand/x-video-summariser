(() => {
'use strict';

const BACKEND = 'http://localhost:47291';
const HOST_ID  = 'xsumm-host';

if (document.getElementById(HOST_ID)) {
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'toggle') document.getElementById(HOST_ID).__toggle();
  });
  return;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

let _n = 0;
const uid = () => (++_n).toString(36);

function tweetUrl() {
  const m = window.location.pathname.match(/^\/[^/]+\/status\/\d+/);
  return m ? `https://x.com${m[0]}` : '';
}

function tweetUrlForVideo(video) {
  const page = tweetUrl();
  if (page) return page;
  let el = video.parentElement;
  while (el && el.tagName !== 'ARTICLE') el = el.parentElement;
  if (!el) return '';
  const a = el.querySelector('a[href*="/status/"]');
  if (!a) return '';
  const m = a.getAttribute('href').match(/\/[^/]+\/status\/\d+/);
  return m ? `https://x.com${m[0]}` : '';
}

function isValidUrl(u) {
  const s = u.trim();
  return /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/.test(s)
      || /^https:\/\/t\.co\/[A-Za-z0-9_-]+$/.test(s);
}

function fmtSecs(s) {
  if (!s) return '';
  const sec = Math.round(s);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), r = sec % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

function fmtBytes(n) {
  if (n == null) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function shortUrl(url) {
  const user = url.match(/\.com\/([^/]+)\/status\/(\d+)/);
  return user ? `@${user[1]}  ·  …${user[2].slice(-6)}` : url.replace(/^https?:\/\//, '').slice(0, 34);
}

// ─── shadow DOM ───────────────────────────────────────────────────────────────

const host = document.createElement('div');
host.id = HOST_ID;
document.body.appendChild(host);
const shadow = host.attachShadow({ mode: 'open' });

const style = document.createElement('style');
style.textContent = `
* { box-sizing: border-box; margin: 0; padding: 0; }

.sidebar {
  position: fixed; top: 0; right: -410px;
  width: 390px; height: 100vh;
  background: #0d0d0d; color: #e8e8e8;
  font-family: -apple-system, 'Inter', system-ui, sans-serif; font-size: 14px;
  display: flex; flex-direction: column;
  z-index: 2147483647;
  transition: right .25s cubic-bezier(.4,0,.2,1), height .2s ease;
  box-shadow: -6px 0 48px rgba(0,0,0,.8);
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}
.sidebar.open      { right: 0; }
.sidebar.minimised { height: 50px; }

/* header */
.header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px; border-bottom: 1px solid #1e1e1e; flex-shrink: 0;
}
.title { font-family: 'JetBrains Mono','Menlo',monospace; font-size: 13px; font-weight: 500; color: #888; letter-spacing: .04em; cursor: default; }
.title .accent { color: #f5a623; }
.hbtns { display: flex; gap: 2px; }
.hbtn {
  background: transparent; border: none; color: #555; font-size: 15px;
  cursor: pointer; padding: 2px 7px; line-height: 1; transition: color .12s;
}
.hbtn:hover { color: #e8e8e8; }
.sidebar.minimised .hbtn.min { color: #f5a623; }

/* server bar */
.srvbar {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 16px; border-bottom: 1px solid #1a1a1a; flex-shrink: 0;
  font-family: 'JetBrains Mono','Menlo',monospace; font-size: 10px; letter-spacing: .06em;
}
.srvdot { width: 6px; height: 6px; border-radius: 50%; background: #3a3a3a; flex-shrink: 0; }
.srvbar.up   .srvdot { background: #4ade80; }
.srvbar.down .srvdot { background: #ff6b6b; }
.srvbar.busy .srvdot { background: #f5a623; animation: blink 1s steps(1) infinite; }
.srvbar.err  .srvdot { background: #ff6b6b; }
.srvtxt { flex: 1; min-width: 0; color: #555; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.srvbar.err .srvtxt { color: #ff6b6b; }
.srvbtn {
  background: transparent; border: 1px solid #2a2a2a; color: #555;
  font-family: inherit; font-size: 10px; letter-spacing: .06em;
  padding: 3px 9px; cursor: pointer; flex-shrink: 0;
  transition: color .12s, border-color .12s;
}
.srvbtn:hover:not(:disabled) { color: #f5a623; border-color: #f5a623; }
.srvbtn:disabled { opacity: .35; cursor: not-allowed; }
.srvbar.down .srvbtn { color: #f5a623; border-color: #f5a623; }
.srvbar.down .srvbtn:hover:not(:disabled) { background: #f5a623; color: #0d0d0d; }

/* add form */
.add-row {
  display: flex; gap: 8px; padding: 12px 16px;
  border-bottom: 1px solid #1a1a1a; flex-shrink: 0;
}
.url-in {
  flex: 1; min-width: 0; background: #161616; border: none;
  color: #e8e8e8; font-family: 'JetBrains Mono','Menlo',monospace; font-size: 12px;
  padding: 8px 12px; outline: none; caret-color: #f5a623;
}
.url-in:focus { background: #1e1e1e; }
.url-in::placeholder { color: #333; }
.add-btn {
  background: transparent; border: 1px solid #f5a623; color: #f5a623;
  font-family: 'JetBrains Mono','Menlo',monospace; font-size: 12px; font-weight: 500;
  padding: 8px 14px; cursor: pointer; flex-shrink: 0; letter-spacing: .04em;
  transition: background .12s, color .12s;
}
.add-btn:hover { background: #f5a623; color: #0d0d0d; }

/* queue scroll area */
.queue {
  flex: 1; overflow-y: auto; padding: 12px 16px;
  display: flex; flex-direction: column; gap: 10px;
  scrollbar-width: thin; scrollbar-color: #2a2a2a transparent;
}
.queue::-webkit-scrollbar { width: 3px; }
.queue::-webkit-scrollbar-thumb { background: #2a2a2a; }

.empty {
  color: #2e2e2e; font-family: 'JetBrains Mono','Menlo',monospace;
  font-size: 11px; margin-top: 32px; text-align: center; line-height: 2;
}

/* card */
.card { border: 1px solid #1e1e1e; background: #111; transition: border-color .2s; }
.card.processing { border-color: #f5a623; }
.card.done       { border-color: #222; }
.card.err        { border-color: #ff6b6b44; }

.card-hd {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px;
}
.cicon { font-size: 12px; flex-shrink: 0; width: 16px; text-align: center; }
.cicon.spin { animation: spin 1.2s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.curl {
  flex: 1; min-width: 0;
  font-family: 'JetBrains Mono','Menlo',monospace; font-size: 11px; color: #555;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.card.done .curl, .card.processing .curl { color: #888; }
.ctog {
  background: transparent; border: none; color: #3a3a3a; font-size: 11px;
  cursor: pointer; padding: 2px 4px; display: none; transition: color .12s; flex-shrink: 0;
}
.card.done .ctog { display: block; }
.ctog:hover { color: #f5a623; }

/* progress inside card */
.card-prog { padding: 0 12px 10px; display: none; }
.card.processing .card-prog { display: block; }
.cstep { font-family: 'JetBrains Mono','Menlo',monospace; font-size: 11px; color: #333; margin-bottom: 3px; }
.cstep.active { color: #f5a623; }
.cstep.done   { color: #555; }
.cstep .mk { display: inline-block; width: 1.8em; }
.cstep .cur { color: #f5a623; animation: blink 1s steps(1) infinite; display: none; }
.cstep.active .cur { display: inline; }
@keyframes blink { 50% { opacity: 0; } }
.cbar { height: 2px; background: #1e1e1e; margin: 3px 0; overflow: hidden; display: none; }
.cbar.show { display: block; }
.cfill { height: 100%; width: 0%; background: #f5a623; transition: width .18s linear; }
.csub { font-family: 'JetBrains Mono','Menlo',monospace; font-size: 10px; color: #3a3a3a; margin-bottom: 4px; }

/* error */
.card-err { padding: 0 12px 10px; font-family: 'JetBrains Mono','Menlo',monospace; font-size: 11px; color: #ff6b6b; display: none; }
.card.err .card-err { display: block; }
.card-err .srvbtn { display: block; margin-top: 7px; color: #f5a623; border-color: #f5a623; }
.card-err .srvbtn:hover:not(:disabled) { background: #f5a623; color: #0d0d0d; }

/* collapsed preview */
.card-prev { padding: 0 12px 10px; font-size: 12px; color: #444; line-height: 1.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: none; }
.card.done:not(.expanded) .card-prev { display: block; }

/* expanded body */
.card-body { display: none; border-top: 1px solid #1a1a1a; }
.card.expanded .card-body { display: block; }

/* tabs */
.ctabs { display: flex; border-bottom: 1px solid #1a1a1a; padding: 0 12px; }
.ctab {
  background: transparent; border: none; border-bottom: 2px solid transparent;
  color: #3a3a3a; font-family: 'JetBrains Mono','Menlo',monospace; font-size: 10px;
  letter-spacing: .08em; padding: 6px 12px 7px; cursor: pointer; margin-bottom: -1px;
  transition: color .12s, border-color .12s;
}
.ctab:hover { color: #888; }
.ctab.active { color: #f5a623; border-bottom-color: #f5a623; }
.cpanel { display: none; padding: 10px 12px; }
.cpanel.active { display: block; }

.csum { font-size: 13px; line-height: 1.65; white-space: pre-wrap; }
.ctx  { font-family: 'JetBrains Mono','Menlo',monospace; font-size: 11px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.cdur { font-family: 'JetBrains Mono','Menlo',monospace; font-size: 10px; color: #333; margin-top: 6px; }

.ccopy {
  float: right; margin: 0 0 6px 8px;
  background: transparent; border: 1px solid #222; color: #3a3a3a;
  font-family: 'JetBrains Mono','Menlo',monospace; font-size: 10px;
  padding: 2px 7px; cursor: pointer; transition: color .12s, border-color .12s;
}
.ccopy:hover, .ccopy.ok { color: #f5a623; border-color: #f5a623; }

/* chat inside card */
.card-chat { border-top: 1px solid #1a1a1a; }
.clabel { font-family: 'JetBrains Mono','Menlo',monospace; font-size: 10px; letter-spacing: .08em; color: #2e2e2e; padding: 8px 12px 4px; }
.clabel::before { content: '── '; }
.cchips { display: flex; flex-wrap: wrap; gap: 5px; padding: 0 12px 8px; }
.cchips.gone { display: none; }
.chip {
  background: #161616; border: 1px solid transparent; color: #3a3a3a;
  font-family: 'JetBrains Mono','Menlo',monospace; font-size: 10px;
  padding: 4px 8px; cursor: pointer; transition: color .12s, border-color .12s;
}
.chip:hover { color: #f5a623; border-color: #f5a623; }
.chip:disabled { opacity: .4; cursor: not-allowed; }

.cthread { display: flex; flex-direction: column; gap: 6px; padding: 0 12px; max-height: 220px; overflow-y: auto; }
.cthread::-webkit-scrollbar { width: 3px; }
.cthread::-webkit-scrollbar-thumb { background: #2a2a2a; }
.cmsg { background: #161616; padding: 8px 10px; font-size: 12px; line-height: 1.5; }
.cmsg.user { background: #1a1a1a; }
.cmsg-r { font-family: 'JetBrains Mono','Menlo',monospace; font-size: 10px; color: #2e2e2e; margin-bottom: 3px; }
.cmsg.user .cmsg-r { color: #f5a623; }
.cmsg-c { white-space: pre-wrap; word-break: break-word; }
.cmsg.streaming .cmsg-c::after { content: '▋'; color: #f5a623; animation: blink 1s steps(1) infinite; }
.cmsg.error .cmsg-c { color: #ff6b6b; }

.cinput-row { display: flex; gap: 6px; padding: 8px 12px 12px; }
.cci {
  flex: 1; min-width: 0; background: #161616; border: none;
  color: #e8e8e8; font-family: -apple-system, system-ui, sans-serif; font-size: 12px;
  padding: 8px 10px; outline: none; caret-color: #f5a623;
}
.cci:focus { background: #1e1e1e; }
.cci:disabled { opacity: .5; }
.ccs {
  background: transparent; border: 1px solid #f5a623; color: #f5a623;
  font-size: 14px; padding: 0 12px; cursor: pointer; flex-shrink: 0;
  transition: background .12s, color .12s;
}
.ccs:hover:not(:disabled) { background: #f5a623; color: #0d0d0d; }
.ccs:disabled { opacity: .4; cursor: not-allowed; }
`;

const sidebar = document.createElement('div');
sidebar.className = 'sidebar';
sidebar.innerHTML = `
  <div class="header">
    <span class="title">⚡ vid <span class="accent">summ</span></span>
    <div class="hbtns">
      <button class="hbtn min" id="min" title="minimise">—</button>
      <button class="hbtn" id="close">✕</button>
    </div>
  </div>
  <div class="srvbar" id="srvbar">
    <span class="srvdot"></span>
    <span class="srvtxt" id="srvtxt">checking server…</span>
    <button class="srvbtn" id="srvbtn" disabled>…</button>
  </div>
  <form class="add-row" id="add-form" autocomplete="off">
    <input type="url" class="url-in" id="url" placeholder="paste x.com/…/status/… url" spellcheck="false">
    <button type="submit" class="add-btn">+ add</button>
  </form>
  <div class="queue" id="queue">
    <div class="empty" id="empty">click ⚡ chat-vs on any video<br>or paste a url above</div>
  </div>
`;

shadow.appendChild(style);
shadow.appendChild(sidebar);

// ─── refs ─────────────────────────────────────────────────────────────────────

const $ = id => shadow.getElementById(id);
const addForm  = $('add-form');
const urlInput = $('url');
const queueEl  = $('queue');
const emptyEl  = $('empty');

// ─── server control ───────────────────────────────────────────────────────────

const NO_BACKEND = 'cannot reach backend — is it running on port 47291?';
const NO_HOST = 'native host not installed — run: bash native-host/install.sh';

const srvBar = $('srvbar'), srvTxt = $('srvtxt'), srvBtn = $('srvbtn');
let srvState = 'unknown';   // unknown | up | down | starting | stopping | error
let pollTimer = null;

// Content scripts can't reach a native host — background.js relays for us.
function native(action) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type: 'server', action }, resp => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message, noHost: true });
        else resolve(resp || { ok: false, error: 'no reply from native host', noHost: true });
      });
    } catch (e) { resolve({ ok: false, error: e.message, noHost: true }); }
  });
}

async function ping() {
  try { return (await fetch(`${BACKEND}/health`, { cache: 'no-store' })).ok; }
  catch { return false; }
}

function setSrv(state, msg) {
  srvState = state;
  let cls = 'busy', txt = 'checking server…', label = '…', off = true;
  if      (state === 'up')       { cls = 'up';   txt = 'server running';  label = 'stop';   off = false; }
  else if (state === 'down')     { cls = 'down'; txt = 'server offline';  label = 'launch'; off = false; }
  else if (state === 'starting') { txt = 'starting server…'; }
  else if (state === 'stopping') { txt = 'stopping server…'; }
  else if (state === 'error')    { cls = 'err'; txt = msg; label = 'retry'; off = false; }
  srvBar.className = `srvbar ${cls}`;
  srvTxt.textContent = txt;
  srvTxt.title = msg || txt;
  srvBtn.textContent = label;
  srvBtn.disabled = off;
}

async function refreshSrv() {
  if (srvState === 'starting' || srvState === 'stopping') return;
  const up = await ping();
  // keep a failure message on screen until the user acts on it — only good
  // news (the server came up) is allowed to clear it.
  if (srvState === 'error' && !up) return;
  setSrv(up ? 'up' : 'down');
}

async function startServer() {
  setSrv('starting');
  const r = await native('start');
  if (r && r.ok) { setSrv('up'); retryStalled(); return true; }
  setSrv('error', r && r.noHost ? NO_HOST : ((r && r.error) || 'could not start server'));
  return false;
}

async function stopServer() {
  setSrv('stopping');
  const r = await native('stop');
  if (r && r.ok) { setSrv('down'); return true; }
  setSrv('error', r && r.noHost ? NO_HOST : ((r && r.error) || 'could not stop server'));
  return false;
}

srvBtn.addEventListener('click', () => {
  if (srvState === 'up') stopServer();
  else if (srvState === 'down' || srvState === 'error') startServer();
});

function startPolling() {
  if (pollTimer) return;
  refreshSrv();
  pollTimer = setInterval(refreshSrv, 5000);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// Anything that died because the server was down gets another go once it's up.
function retryStalled() {
  queue.filter(i => i.status === 'error' && i.err === NO_BACKEND).forEach(retryItem);
}

function retryItem(item) {
  const c = item.el; if (!c) return;
  item.status = 'processing'; item.err = '';
  c.className = 'card processing';
  const ico = $(`ico-${item.id}`); if (ico) { ico.textContent = '◌'; ico.classList.add('spin'); }
  const err = $(`cerr-${item.id}`); if (err) err.textContent = '';
  processItem(item);
}

// ─── toggle / minimise ────────────────────────────────────────────────────────

let isOpen = false, isMini = false;

function toggle(force) {
  isOpen = force !== undefined ? force : !isOpen;
  sidebar.classList.toggle('open', isOpen);
  if (isOpen && !urlInput.value) { const t = tweetUrl(); if (t) urlInput.value = t; }
  if (isOpen) startPolling(); else stopPolling();
}

function toggleMin() {
  isMini = !isMini;
  sidebar.classList.toggle('minimised', isMini);
  const b = $('min'); b.textContent = isMini ? '▢' : '—'; b.title = isMini ? 'restore' : 'minimise';
}

host.__toggle = toggle;
shadow.querySelector('.title').addEventListener('click', () => { if (isMini) toggleMin(); });
$('min').addEventListener('click', toggleMin);
$('close').addEventListener('click', () => toggle(false));
chrome.runtime.onMessage.addListener(msg => { if (msg.type === 'toggle') toggle(); });
if (tweetUrl()) toggle(true);

// ─── queue state ──────────────────────────────────────────────────────────────

const queue = [];

// ─── card builder ─────────────────────────────────────────────────────────────

const STEPS = ['downloading', 'transcribing', 'summarizing'];

function buildCard(item) {
  const id = item.id;
  const c = document.createElement('div');
  c.className = 'card queued';
  c.id = `card-${id}`;
  c.innerHTML = `
    <div class="card-hd">
      <span class="cicon" id="ico-${id}">⏳</span>
      <span class="curl">${shortUrl(item.url)}</span>
      <button class="ctog" id="tog-${id}">▾</button>
    </div>
    <div class="card-prog" id="prog-${id}">
      <div class="cstep" id="sdl-${id}"><span class="mk"></span>downloading<span class="cur"> _</span>
        <div class="cbar" id="bdl-${id}"><div class="cfill" id="fdl-${id}"></div></div>
        <div class="csub" id="sdl-sub-${id}"></div>
      </div>
      <div class="cstep" id="stx-${id}"><span class="mk"></span>transcribing<span class="cur"> _</span>
        <div class="cbar" id="btx-${id}"><div class="cfill" id="ftx-${id}"></div></div>
        <div class="csub" id="stx-sub-${id}"></div>
      </div>
      <div class="cstep" id="ssm-${id}"><span class="mk"></span>summarizing<span class="cur"> _</span></div>
    </div>
    <div class="card-err" id="cerr-${id}"></div>
    <div class="card-prev" id="cprev-${id}"></div>
    <div class="card-body" id="cbody-${id}">
      <div class="ctabs">
        <button class="ctab active" data-tab="summary">summary</button>
        <button class="ctab" data-tab="transcript">transcript</button>
      </div>
      <div class="cpanel active" data-panel="summary">
        <button class="ccopy" data-src="sum">copy</button>
        <div class="csum" id="csum-${id}"></div>
        <div class="cdur" id="cdur-${id}"></div>
      </div>
      <div class="cpanel" data-panel="transcript">
        <button class="ccopy" data-src="tx">copy</button>
        <div class="ctx" id="ctx-${id}"></div>
      </div>
      <div class="card-chat">
        <div class="clabel">chat</div>
        <div class="cchips" id="chips-${id}">
          <button class="chip" data-q="What are the key takeaways?">key takeaways</button>
          <button class="chip" data-q="Explain this simply.">explain simply</button>
          <button class="chip" data-q="What is the main argument?">main argument</button>
        </div>
        <div class="cthread" id="th-${id}"></div>
        <div class="cinput-row">
          <input class="cci" id="ci-${id}" type="text" placeholder="ask a follow-up..." autocomplete="off">
          <button class="ccs" id="cs-${id}">→</button>
        </div>
      </div>
    </div>
  `;

  // tabs
  c.querySelectorAll('.ctab').forEach(t => {
    t.addEventListener('click', () => {
      c.querySelectorAll('.ctab').forEach(x => x.classList.toggle('active', x === t));
      c.querySelectorAll('.cpanel').forEach(p => p.classList.toggle('active', p.dataset.panel === t.dataset.tab));
    });
  });

  // expand toggle
  const tog = c.querySelector(`#tog-${id}`);
  tog.addEventListener('click', () => {
    item.expanded = !item.expanded;
    c.classList.toggle('expanded', item.expanded);
    tog.textContent = item.expanded ? '▴' : '▾';
  });

  // copy
  c.querySelectorAll('.ccopy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.src === 'sum' ? item.summary : item.transcript;
      try {
        await navigator.clipboard.writeText(text);
        const o = btn.textContent; btn.textContent = 'copied!'; btn.classList.add('ok');
        setTimeout(() => { btn.textContent = o; btn.classList.remove('ok'); }, 1200);
      } catch { btn.textContent = 'failed'; }
    });
  });

  // chat
  const ci = c.querySelector(`#ci-${id}`);
  const cs = c.querySelector(`#cs-${id}`);
  const doSend = () => { const q = ci.value.trim(); if (q) { ci.value = ''; chatItem(item, q); } };
  cs.addEventListener('click', doSend);
  ci.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
  c.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => chatItem(item, chip.dataset.q));
  });

  item.el = c;
  return c;
}

// ─── card updaters ────────────────────────────────────────────────────────────

function setStep(item, name, state) {
  const map = { downloading: 'sdl', transcribing: 'stx', summarizing: 'ssm' };
  const el = $(`${map[name]}-${item.id}`); if (!el) return;
  el.classList.remove('active', 'done');
  const mk = el.querySelector('.mk');
  if (state === 'active') { el.classList.add('active');  mk.textContent = '◌ '; }
  if (state === 'done')   { el.classList.add('done');    mk.textContent = '✓ '; }
}

function advance(item, step) {
  const idx = STEPS.indexOf(step);
  for (let i = 0; i < idx; i++) setStep(item, STEPS[i], 'done');
  setStep(item, step, 'active');
}

function dlProg(item, p) {
  const bar = $(`bdl-${item.id}`), fill = $(`fdl-${item.id}`), sub = $(`sdl-sub-${item.id}`);
  const pts = [];
  if (p.phase === 'extracting') { pts.push('extracting audio…'); if (fill) fill.style.width = '100%'; }
  else {
    if (p.downloaded) pts.push(fmtBytes(p.downloaded) + (p.total ? ` / ${fmtBytes(p.total)}` : ''));
    if (p.percent != null) { pts.push(`${p.percent.toFixed(0)}%`); if (bar) bar.classList.add('show'); if (fill) fill.style.width = `${Math.min(100,p.percent).toFixed(1)}%`; }
    if (p.speed) pts.push(`${fmtBytes(p.speed)}/s`);
  }
  if (sub && pts.length) sub.textContent = pts.join(' · ');
}

function txProg(item, p) {
  const bar = $(`btx-${item.id}`), fill = $(`ftx-${item.id}`), sub = $(`stx-sub-${item.id}`);
  const pts = [];
  if (p.current != null && p.total) pts.push(`${fmtSecs(p.current)} / ${fmtSecs(p.total)}`);
  if (p.percent != null) { pts.push(`${p.percent.toFixed(0)}%`); if (bar) bar.classList.add('show'); if (fill) fill.style.width = `${Math.min(100,p.percent).toFixed(1)}%`; }
  if (sub && pts.length) sub.textContent = pts.join(' · ');
}

function markDone(item) {
  const c = item.el; if (!c) return;
  c.className = 'card done expanded';
  const ico = $(`ico-${item.id}`); if (ico) { ico.textContent = '✓'; ico.classList.remove('spin'); }
  const tog = $(`tog-${item.id}`); if (tog) tog.textContent = '▴';
  const sum = $(`csum-${item.id}`); if (sum) sum.textContent = item.summary;
  const tx  = $(`ctx-${item.id}`);  if (tx)  tx.textContent  = item.transcript;
  const dur = $(`cdur-${item.id}`); if (dur) dur.textContent = item.duration ? `video duration: ${fmtSecs(item.duration)}` : '';
  const prev = $(`cprev-${item.id}`); if (prev) prev.textContent = item.summary.slice(0, 90) + (item.summary.length > 90 ? '…' : '');
  item.expanded = true;
  c.scrollIntoView({ block: 'nearest' });
}

function markErr(item, msg) {
  const c = item.el; if (!c) return;
  item.err = msg;
  c.className = 'card err';
  const ico = $(`ico-${item.id}`); if (ico) { ico.textContent = '✗'; ico.classList.remove('spin'); }
  const err = $(`cerr-${item.id}`); if (!err) return;
  err.textContent = msg;
  if (msg !== NO_BACKEND) return;
  setSrv('down');
  const b = document.createElement('button');
  b.className = 'srvbtn';
  b.textContent = 'launch server & retry';
  b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = 'starting…';
    // on success startServer() calls retryStalled(), which redraws this card
    if (!await startServer()) { b.disabled = false; b.textContent = 'launch server & retry'; }
  });
  err.appendChild(b);
}

// ─── add to queue ─────────────────────────────────────────────────────────────

function addToQueue(url) {
  url = url.trim();
  if (!isValidUrl(url)) return false;
  // already in queue — scroll to it
  const existing = queue.find(i => i.url === url);
  if (existing) { existing.el?.scrollIntoView({ block: 'nearest' }); return true; }
  const item = { id: uid(), url, status: 'processing', summary: '', transcript: '', duration: null, messages: [], chatBusy: false, expanded: false, el: null, err: '' };
  queue.push(item);
  emptyEl.style.display = 'none';
  const card = buildCard(item);
  card.className = 'card processing';
  const ico = $(`ico-${item.id}`); if (ico) { ico.textContent = '◌'; ico.classList.add('spin'); }
  queueEl.appendChild(card);
  processItem(item); // fire-and-forget — downloads run in parallel
  return true;
}

async function processItem(item) {
  try {
    let resp;
    try {
      resp = await fetch(`${BACKEND}/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.url }),
      });
    } catch { throw new Error('cannot reach backend — is it running on port 47291?'); }
    if (!resp.ok || !resp.body) throw new Error(`backend error (${resp.status})`);
    const reader = resp.body.getReader(), dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, sep); buf = buf.slice(sep + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let p; try { p = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if      (p.type === 'progress')             advance(item, p.step);
          else if (p.type === 'download_progress')    dlProg(item, p);
          else if (p.type === 'transcribe_progress')  txProg(item, p);
          else if (p.type === 'done') {
            item.summary = p.summary || ''; item.transcript = p.transcript || ''; item.duration = p.duration_seconds || null;
            item.status = 'done'; markDone(item); return;
          }
          else if (p.type === 'error') throw new Error(p.message);
        }
      }
    }
  } catch (err) { item.status = 'error'; markErr(item, err.message || 'something went wrong'); }
}

// ─── per-card chat ────────────────────────────────────────────────────────────

function appendMsg(item, role, text) {
  const th = $(`th-${item.id}`); if (!th) return null;
  const w = document.createElement('div'); w.className = `cmsg ${role}`;
  const r = document.createElement('div'); r.className = 'cmsg-r'; r.textContent = role === 'user' ? 'you' : 'claude';
  const t = document.createElement('div'); t.className = 'cmsg-c'; t.textContent = text || '';
  w.append(r, t); th.append(w); th.scrollTop = th.scrollHeight;
  return { w, t };
}

function setBusy(item, v) {
  item.chatBusy = v;
  const ci = $(`ci-${item.id}`), cs = $(`cs-${item.id}`);
  if (ci) ci.disabled = v;
  if (cs) { cs.disabled = v; cs.textContent = v ? '…' : '→'; }
  item.el?.querySelectorAll('.chip').forEach(b => { b.disabled = v; });
}

async function chatItem(item, q) {
  if (!q || item.chatBusy || !item.transcript) return;
  $(`chips-${item.id}`)?.classList.add('gone');
  item.messages.push({ role: 'user', content: q });
  appendMsg(item, 'user', q);
  const { w, t } = appendMsg(item, 'assistant', '');
  setBusy(item, true);
  try {
    const resp = await fetch(`${BACKEND}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: item.transcript, messages: item.messages }),
    });
    if (!resp.ok || !resp.body) throw new Error(`backend error (${resp.status})`);
    w.classList.add('streaming');
    const reader = resp.body.getReader(), dec = new TextDecoder();
    let buf = '', full = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, sep); buf = buf.slice(sep + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let p; try { p = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (p.type === 'token') { full += p.text; t.textContent = full; const th = $(`th-${item.id}`); if (th) th.scrollTop = th.scrollHeight; }
            else if (p.type === 'done')  { item.messages.push({ role: 'assistant', content: full }); return; }
            else if (p.type === 'error') throw new Error(p.message);
          }
        }
      }
    } finally { w.classList.remove('streaming'); }
  } catch (err) {
    w.classList.add('error'); t.textContent = `[error] ${err.message}`;
    item.messages.pop();
  } finally {
    setBusy(item, false);
    $(`ci-${item.id}`)?.focus();
  }
}

// ─── manual add form ──────────────────────────────────────────────────────────

addForm.addEventListener('submit', e => {
  e.preventDefault();
  if (addToQueue(urlInput.value)) { urlInput.value = ''; toggle(true); }
});

// ─── video button injection ───────────────────────────────────────────────────

const injected = new WeakSet();

function injectButtons() {
  document.querySelectorAll('video').forEach(video => {
    if (injected.has(video)) return;
    injected.add(video);
    const url = tweetUrlForVideo(video);
    if (!url) return;
    const container = video.parentElement;
    if (!container) return;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    const btn = document.createElement('button');
    btn.textContent = '⚡ chat-vs';
    Object.assign(btn.style, {
      position: 'absolute', top: '10px', left: '10px', zIndex: '9999',
      background: 'rgba(0,0,0,0.72)', color: '#f5a623',
      border: '1px solid #f5a623',
      fontFamily: "'JetBrains Mono','Menlo',monospace",
      fontSize: '11px', fontWeight: '500', padding: '5px 10px',
      cursor: 'pointer', letterSpacing: '0.04em',
      backdropFilter: 'blur(4px)', borderRadius: '2px',
      transition: 'background 0.12s, color 0.12s',
    });
    btn.addEventListener('mouseenter', () => { btn.style.background = '#f5a623'; btn.style.color = '#0d0d0d'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(0,0,0,0.72)'; btn.style.color = '#f5a623'; });
    btn.addEventListener('click', e => {
      e.stopPropagation(); e.preventDefault();
      toggle(true);
      addToQueue(url);
    });
    container.appendChild(btn);
  });
}

injectButtons();
const obs = new MutationObserver(injectButtons);
obs.observe(document.body, { childList: true, subtree: true });

})();
