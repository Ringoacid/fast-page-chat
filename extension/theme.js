export function applyTheme(theme) { document.documentElement.dataset.theme = ['light', 'dark'].includes(theme) ? theme : 'system'; }
applyTheme((await chrome.storage.local.get('settings')).settings?.theme);
