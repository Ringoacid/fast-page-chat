// Chrome's automatic side-panel toggle skips the activeTab grant. A normal
// toolbar action grants it before this listener opens the panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);
const openWindows = new Set();
const changedWindows = new Set();
// Restore presence after the MV3 worker is restarted while a panel is open.
chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'], documentUrls: [chrome.runtime.getURL('panel.html')] })
  .then(contexts => {
    for (const context of contexts) if (!changedWindows.has(context.windowId)) openWindows.add(context.windowId);
  }).catch(console.error);
chrome.sidePanel.onOpened?.addListener(info => {
  if (info.path.replace(/^\/+/, '') !== 'panel.html') return;
  changedWindows.add(info.windowId); openWindows.add(info.windowId);
});
chrome.sidePanel.onClosed?.addListener(info => {
  if (info.path.replace(/^\/+/, '') !== 'panel.html') return;
  changedWindows.add(info.windowId); openWindows.delete(info.windowId);
});
chrome.action.onClicked.addListener(tab => {
  if (!Number.isInteger(tab?.id) || tab.id < 0 || !Number.isInteger(tab.windowId)) return;
  if (openWindows.has(tab.windowId)) {
    changedWindows.add(tab.windowId);
    openWindows.delete(tab.windowId);
    chrome.sidePanel.close({ windowId: tab.windowId }).catch(error => {
      openWindows.add(tab.windowId); console.error(error);
    });
    return;
  }
  // Call open directly in the action gesture; awaiting an API first can lose it.
  chrome.sidePanel.open({ windowId: tab.windowId }).then(() => {
    changedWindows.add(tab.windowId); openWindows.add(tab.windowId);
    // An already open panel needs a new capture after this tab receives access.
    // A newly created panel may not be listening yet; its boot captures instead.
    chrome.runtime.sendMessage({ type: 'toolbar-capture', tabId: tab.id, windowId: tab.windowId }).catch(() => {});
  }).catch(console.error);
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
});
