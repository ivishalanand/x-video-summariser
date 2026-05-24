const statusEl = document.getElementById("status");
const appEl = document.getElementById("app");

const TWEET_URL = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/i;

function send(type) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type }, (resp) => resolve(resp));
  });
}

function showError(errorMsg) {
  statusEl.replaceChildren();
  const lead = document.createElement("div");
  lead.className = "err";
  lead.textContent = "backend didn't start.";
  statusEl.append(lead, document.createElement("br"));

  const detail = document.createElement("div");
  detail.textContent = errorMsg || "unknown error";
  statusEl.append(detail, document.createElement("br"));

  const help = document.createElement("div");
  help.append(
    document.createTextNode("did you install the native host? from the repo root run: "),
  );
  const cmd = document.createElement("code");
  cmd.textContent = "./native-host/install.sh <extension-id>";
  help.append(cmd);
  statusEl.append(help);

  statusEl.classList.remove("hidden");
  appEl.classList.add("hidden");
}

(async () => {
  const resp = await send("ensure_server");
  if (!resp?.ok) {
    showError(resp?.error);
    return;
  }

  const tab = await send("get_tab_url");
  const tabUrl = tab?.url || "";
  const baseUrl = resp.url || "http://127.0.0.1:8001";
  appEl.src = TWEET_URL.test(tabUrl)
    ? `${baseUrl}/?url=${encodeURIComponent(tabUrl)}`
    : baseUrl;
  appEl.classList.remove("hidden");
  statusEl.classList.add("hidden");
})();
