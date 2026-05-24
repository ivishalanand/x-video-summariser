const HOST_NAME = "com.vishal.x_summariser";

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "ensure_server") {
    chrome.runtime.sendNativeMessage(HOST_NAME, { action: "ensure_server" }, (resp) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse(resp);
      }
    });
    return true;
  }
  if (msg?.type === "get_tab_url") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse({ url: tabs[0]?.url || "" });
    });
    return true;
  }
});
