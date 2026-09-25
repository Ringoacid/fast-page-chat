// Chrome's automatic side-panel toggle skips the activeTab grant. A normal
// toolbar action grants it before this listener opens the panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);
chrome.action.onClicked.addListener(tab => {
  if (!Number.isInteger(tab?.id) || tab.id < 0 || !Number.isInteger(tab.windowId)) return;
  chrome.sidePanel.open({ windowId: tab.windowId }).then(() => {
    // An already open panel needs a new capture after this tab receives access.
    // A newly created panel may not be listening yet; its boot captures instead.
    chrome.runtime.sendMessage({ type: 'toolbar-capture', tabId: tab.id, windowId: tab.windowId }).catch(() => {});
  }).catch(console.error);
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
});
