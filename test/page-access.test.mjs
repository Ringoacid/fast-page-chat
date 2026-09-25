import test from 'node:test';
import assert from 'node:assert/strict';
import { captureTab, readIdentity, sameDocument } from '../extension/page-access.js';

test('missing tab.url still attempts extraction and keeps raw URL out of the page payload', async () => {
  let target;
  const api = { scripting: { executeScript: async options => {
    target = options.target;
    return [{ documentId: 'doc-1', result: { sourceUrl: 'https://example.com/article?private=secret', url: 'https://example.com/article', title: 'Article', text: 'The page body.' } }];
  } } };
  const result = await captureTab(api, { id: 42 }, 'page');
  assert.deepEqual(target, { tabId: 42 });
  assert.equal(result.identity.documentId, 'doc-1');
  assert.equal(result.identity.url, 'https://example.com/article?private=secret');
  assert.equal(result.page.sourceUrl, undefined);
  assert.ok(!JSON.stringify(result.page).includes('secret'));
});

test('permission denial explains toolbar activation rather than misclassifying the webpage', async () => {
  const api = { scripting: { executeScript: async () => { throw new Error('Cannot access contents of url. Extension manifest must request permission to access this host.'); } } };
  await assert.rejects(captureTab(api, { id: 42 }, 'page'), /アクセス権.*「F」/);
});

test('known internal pages are rejected before injection; tab ID zero is valid', async () => {
  let calls = 0;
  const api = { scripting: { executeScript: async () => { calls++; return [{ result: 'https://example.com', documentId: '1' }]; } } };
  await assert.rejects(readIdentity(api, { id: 42, url: 'brave://settings/' }), /設定画面/);
  assert.equal(calls, 0);
  assert.equal((await readIdentity(api, { id: 0 })).url, 'https://example.com');
});

test('identity detects reloads and same-tab navigation with URL metadata withheld', () => {
  const old = { url: 'https://example.com/a', documentId: '1' };
  assert.equal(sameDocument(old, { ...old }), true);
  assert.equal(sameDocument(old, { ...old, documentId: '2' }), false);
  assert.equal(sameDocument(old, { ...old, url: 'https://example.com/b' }), false);
  assert.equal(sameDocument(old, null), false);
});

test('toolbar uses the normal action path and refreshes only its clicked window and tab', async () => {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const events = [];
  let action;
  const chrome = {
    sidePanel: {
      setPanelBehavior: async value => { events.push(['behavior', value.openPanelOnActionClick]); },
      open: async value => { events.push(['open', value.windowId]); }
    },
    action: { onClicked: { addListener(listener) { action = listener; } } },
    runtime: {
      onInstalled: { addListener() {} },
      sendMessage: async value => { events.push(['capture', value.type, value.tabId, value.windowId]); }
    }
  };
  runInNewContext(await readFile(new URL('../extension/background.js', import.meta.url), 'utf8'), { chrome, console });
  assert.deepEqual(events, [['behavior', false]]);
  assert.equal(typeof action, 'function');
  action({ id: 42, windowId: 7 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [['behavior', false], ['open', 7], ['capture', 'toolbar-capture', 42, 7]]);
  action({ id: -1, windowId: 7 }); action({ id: 42 }); action();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 3, 'Missing or invalid clicked tabs must not open or capture another tab.');
});
