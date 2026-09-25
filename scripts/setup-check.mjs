// Isolated desktop MV3 onboarding checks. Native host and model responses are mocked.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const token = 'a'.repeat(64), requests = [];
let configured = false, apiModel = '', protocolVersion = 1, codexSignedIn = false;
const server = createServer(async (req, res) => {
  if (req.url === '/article') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>セットアップの検証記事</title><main><h1>セットアップの検証記事</h1><p>同意した後にだけ取得する本文です。</p></main>'); return;
  }
  if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type' }); res.end(); return; }
  if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); res.end('{}'); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : undefined;
  requests.push({ path: req.url, body });
  const json = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.url === '/health') return json({ ok: true, protocolVersion, version: '0.10.0', apiConfigured: configured, apiModel });
  if (req.url === '/diagnostics') return json({ protocolVersion, version: '0.10.0', codex: { state: codexSignedIn ? 'ready' : 'signed_out', message: codexSignedIn ? 'Codexにログイン済みです。' : 'Codexにログインしてください。' }, api: { state: configured ? 'configured' : 'missing', message: configured ? 'API設定を保存済みです。' : 'APIキーが未設定です。' } });
  if (req.url === '/login/start') return json({ authUrl: 'https://auth.openai.com/oauth/authorize?state=local-test-only', loginId: 'local-test-only' });
  if (req.url === '/login/status') { codexSignedIn = true; return json({ state: 'ready', message: 'ログイン完了' }); }
  if (req.url === '/settings/api') { configured = true; apiModel = body.model; return json({ ok: true, apiConfigured: true, apiModel }); }
  if (req.url === '/title') return json({ title: '初回設定を確認する' });
  if (req.url === '/chat') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ type: 'delta', text: '初回設定が完了しました。' }) + '\n\ndata: {"type":"done"}\n\n'); return;
  }
  if (req.url === '/logs/clear') return json({ ok: true, count: 2 });
  res.writeHead(404); res.end('{}');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const endpoint = 'http://127.0.0.1:' + server.address().port;
let context;
try {
  const extension = resolve('test-results/setup-extension');
  await mkdir('test-results', { recursive: true }); await cp(resolve('extension'), extension, { recursive: true });
  const setupPath = resolve(extension, 'setup.js');
  await writeFile(setupPath, (await readFile(setupPath, 'utf8')).replaceAll('http://127.0.0.1:4318', endpoint));
  context = await chromium.launchPersistentContext(resolve('test-results/setup-profile-' + Date.now()), {
    headless: true, channel: 'chromium', executablePath: process.env.CHROMIUM_BIN || undefined,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension], viewport: { width: 390, height: 900 }
  });
  context.setDefaultTimeout(10000);
  let worker = context.serviceWorkers()[0]; if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const source = await context.newPage(); await source.goto(endpoint + '/article');
  const sourceTab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), endpoint + '/article');
  const panel = await context.newPage(), errors = [];
  panel.on('pageerror', error => errors.push(error.message));
  await panel.addInitScript(({ tabId, token, endpoint }) => {
    window.captureCount = 0; window.nativeCalls = 0; window.nativeMissing = true;
    const execute = chrome.scripting.executeScript.bind(chrome.scripting);
    chrome.scripting.executeScript = async (...args) => {
      window.captureCount++;
      if (window.holdNextCapture) {
        window.holdNextCapture = false; window.capturePaused = true;
        await new Promise(resolve => { window.releaseCapture = resolve; });
      }
      return execute(...args);
    };
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async info => info.active ? [await chrome.tabs.get(tabId)] : query(info);
    chrome.tabs.create = async info => { window.openedLoginUrl = info.url; return { id: 999999, url: info.url }; };
    chrome.runtime.sendNativeMessage = async (name, message) => {
      window.nativeCalls++; window.nativeRequest = { name, message };
      if (window.nativeMissing) throw new Error('Specified native messaging host not found.');
      return { ok: true, token, endpoint, version: '0.10.0', protocolVersion: 1 };
    };
  }, { tabId: sourceTab.id, token, endpoint });
  await panel.goto('chrome-extension://' + extensionId + '/panel.html');
  await panel.locator('#setup-consent').waitFor({ state: 'visible' });
  // Real extension messages/extraction below verify panel routing and consent.
  // This headless fixture cannot prove Chrome grants activeTab on toolbar clicks.
  const toolbarCapture = (tabId = sourceTab.id, windowId = sourceTab.windowId) => worker.evaluate(message => chrome.runtime.sendMessage(message).catch(() => null), { type: 'toolbar-capture', tabId, windowId });
  assert.deepEqual(await toolbarCapture(), { captured: false });
  assert.equal(await panel.evaluate(() => window.captureCount), 0);
  assert.equal(await panel.locator('#source-text').textContent(), '');
  assert.equal(requests.length, 0);
  await panel.setViewportSize({ width: 320, height: 900 });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await panel.screenshot({ path: 'test-results/setup-consent-320.png', animations: 'disabled' });
  await panel.locator('#setup-dialog [data-close]').click();
  await panel.evaluate(() => { document.querySelector('#question').value = '未同意の送信'; document.querySelector('#chat-form').requestSubmit(); });
  await panel.locator('#setup-consent').waitFor({ state: 'visible' });
  assert.equal(requests.length, 0); assert.equal(await panel.evaluate(() => window.captureCount), 0);
  await panel.locator('#consent-check').check(); await panel.locator('#consent-continue').click();
  assert.deepEqual(await toolbarCapture(), { captured: false });
  assert.equal(await panel.evaluate(() => window.captureCount), 0, 'The setup dialog must still prevent reading after consent.');
  await panel.locator('#setup-connect').click();
  await panel.locator('#setup-status').filter({ hasText: '補助アプリが見つかりません' }).waitFor();
  assert.equal((await worker.evaluate(() => chrome.storage.local.get('settings'))).settings.token, '');
  await panel.evaluate(() => { window.nativeMissing = false; });
  await panel.locator('#setup-connect').click();
  await panel.locator('#codex-diagnostic').filter({ hasText: 'ログインしてください' }).waitFor();
  assert.equal(await panel.locator('#setup-finish').isDisabled(), true);
  assert.deepEqual(await panel.evaluate(() => window.nativeRequest), { name: 'com.fastpagechat.bridge', message: { type: 'connect' } });
  await panel.locator('#codex-login').click();
  await panel.locator('#setup-status').filter({ hasText: '読みたいページに戻ってから開始' }).waitFor();
  assert.equal(await panel.evaluate(() => window.openedLoginUrl), 'https://auth.openai.com/oauth/authorize?state=local-test-only');
  await panel.locator('#login-check').click();
  await panel.locator('#setup-status').filter({ hasText: '読みたいページに戻ってから「ページを読み始める」' }).waitFor();
  assert.equal(await panel.evaluate(() => window.captureCount), 0, 'Completing login must not start reading the authentication tab.');
  await panel.locator('#setup-provider').selectOption('api');
  await panel.locator('#setup-api-key').fill('sk-test-only-never-real');
  await panel.locator('#setup-api-model').fill('test-model');
  await panel.locator('#api-save').click();
  await panel.waitForFunction(() => !document.querySelector('#setup-finish').disabled);
  assert.equal(await panel.locator('#setup-api-key').inputValue(), '');
  assert.ok(!JSON.stringify(await worker.evaluate(() => chrome.storage.local.get(null))).includes('sk-test-only-never-real'));
  await panel.screenshot({ path: 'test-results/setup-api-320.png', animations: 'disabled' });
  await panel.locator('#setup-finish').click();
  await panel.waitForFunction(() => document.querySelector('#source-text').textContent.includes('同意した後にだけ'));
  const beforeToolbar = await panel.evaluate(() => window.captureCount);
  assert.deepEqual(await toolbarCapture(sourceTab.id + 10000), { captured: false });
  await toolbarCapture(sourceTab.id, sourceTab.windowId + 10000);
  assert.equal(await panel.evaluate(() => window.captureCount), beforeToolbar, 'A stale tab or another window must not capture the current page.');
  await source.evaluate(() => { document.querySelector('main p').textContent = 'ツールバーを再クリックして取得した本文です。'; });
  await panel.evaluate(() => { window.holdNextCapture = true; });
  const currentCapture = toolbarCapture();
  await panel.waitForFunction(() => window.capturePaused);
  assert.deepEqual(await toolbarCapture(sourceTab.id + 10000), { captured: false });
  await panel.evaluate(() => window.releaseCapture());
  assert.deepEqual(await currentCapture, { captured: true }, 'A stale toolbar message must not cancel an in-flight capture of the current tab.');
  await panel.waitForFunction(() => document.querySelector('#source-text').textContent.includes('再クリックして取得'));
  await source.evaluate(() => {
    const paragraph = document.querySelector('main p'); paragraph.textContent = 'パネルの再取得ボタンで取得した本文です。';
    const range = document.createRange(); range.selectNodeContents(paragraph);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  await panel.locator('#source-open').click();
  await panel.locator('#refresh').click();
  await panel.waitForFunction(() => document.querySelector('#source-text').textContent.includes('再取得ボタン'));
  await panel.locator('#scope').selectOption('selection');
  await panel.waitForFunction(() => document.querySelector('#source-text').textContent === 'パネルの再取得ボタンで取得した本文です。');
  await panel.locator('#scope').selectOption('page');
  await panel.waitForFunction(() => document.querySelector('#source-text').textContent.includes('セットアップの検証記事'));
  await panel.locator('dialog[open] [data-close]').click();
  await panel.locator('#question').fill('本文を要約'); await panel.locator('#send').click();
  await panel.waitForFunction(() => document.querySelector('#chat-title').textContent === '初回設定を確認する');
  assert.equal(requests.find(request => request.path === '/chat').body.provider, 'api');
  assert.equal(requests.find(request => request.path === '/title').body.provider, 'api');
  assert.equal(requests.find(request => request.path === '/title').body.model, 'test-model');
  const savedSource = await panel.locator('#source-text').textContent(), savedCaptures = await panel.evaluate(() => window.captureCount);
  await source.evaluate(() => { document.querySelector('main p').textContent = '保存済みチャットに混ぜてはいけない新しい本文です。'; });
  assert.deepEqual(await toolbarCapture(), { captured: false });
  assert.equal(await panel.locator('#source-text').textContent(), savedSource, 'Toolbar actions must not replace an existing chat source.');
  assert.equal(await panel.evaluate(() => window.captureCount), savedCaptures);
  await panel.locator('#settings-open').click(); await panel.locator('#clear-chats').click();
  await worker.evaluate(() => new Promise(resolve => {
    navigator.locks.request('fast-page-chat-data', { mode: 'shared' }, () => {
      resolve(); return new Promise(release => { globalThis.releaseTestDataLock = release; });
    });
  }));
  await panel.locator('#clear-chats-confirm').click();
  await panel.locator('#clear-chats-error').filter({ hasText: '別のパネルで処理中' }).waitFor();
  await worker.evaluate(() => globalThis.releaseTestDataLock());
  await panel.locator('#clear-chats-confirm').click();
  await panel.locator('#data-settings-status').filter({ hasText: 'すべてのチャット' }).waitFor();
  assert.equal(await panel.evaluate(async () => { const db = await (await import('./chat-store.js')).openStore(); const chats = await db.list('chats'); db.db.close(); return chats.length; }), 0);
  await panel.locator('#clear-logs').click(); await panel.locator('#data-settings-status').filter({ hasText: '2件' }).waitFor();
  protocolVersion = 2;
  await panel.reload();
  await panel.locator('#setup-status').filter({ hasText: '補助アプリ' }).waitFor();
  await panel.evaluate(() => { window.nativeMissing = false; });
  await panel.locator('#setup-connect').click();
  await panel.locator('#setup-status').filter({ hasText: '更新が必要' }).waitFor();
  assert.equal(await panel.locator('#setup-account').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('Onboarding integration passed: consent, toolbar recapture and tab/window isolation (not the native activeTab grant), recovery, native pairing, API key non-persistence, same-provider title, deletion, protocol mismatch.');
} finally { await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
