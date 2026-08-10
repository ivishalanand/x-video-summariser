const NATIVE_HOST = 'com.vishal.x_summariser';

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {});
});

// Content scripts can't talk to a native host directly — relay for them.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'server') return;
  chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: msg.action }, (resp) => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message, noHost: true });
    } else {
      sendResponse(resp);
    }
  });
  return true; // keep the channel open for the async reply
});
