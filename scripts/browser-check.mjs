// Isolated MV3 integration checks. No real model requests or user profile changes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBridge } from '../server/http.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
await mkdir('test-results', { recursive: true });
const imageRequests = [];
const fixture = createServer((req, res) => {
  if (req.url.startsWith('/picture.svg')) {
    imageRequests.push({ url: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="140"><rect width="240" height="140" fill="#dc2626"/><text x="20" y="80" fill="white" font-size="30">Diagram</text></svg>'); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const other = req.url.startsWith('/other');
  res.end('<!doctype html><html><head><title>' + (other ? 'Another page' : 'A quieter way to read the web') + '</title></head><body><nav>Navigation clutter</nav><main><h1>' + (other ? 'Another page' : 'A quieter way to read the web') + '</h1><article><p>' + (other ? 'This is a different document.' : 'Good tools let us spend more time understanding and less time searching.') + '</p><p>By bringing the page into the conversation, an assistant can answer directly.</p></article><section><h2>Discussion</h2><p>Loaded comment: context matters.</p></section><p hidden>HIDDEN SECRET</p><p style="display:none">CSS SECRET</p><input value="PRIVATE INPUT"><div contenteditable="true">PRIVATE DRAFT</div><div id="shadow"></div></main><footer>Footer clutter</footer><script>document.getElementById("shadow").attachShadow({mode:"open"}).innerHTML="<p>Shadow text.</p>";</script></body></html>');
});
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
let lastRequest, mode = 'normal', canceled = false, count = 0;
const titleRequests = [];
let releaseScrollMore, releaseScrollDone;
const answer = async (request, emit, signal) => {
  if (request.titleInput) {
    titleRequests.push(request);
    emit({ type: 'delta', text: titleRequests.length === 1 ? '最初のAIタイトル' : '更新されたAIタイトル' });
    return;
  }
  lastRequest = request; count++;
  if (mode === 'scroll') {
    emit({ type: 'delta', text: Array.from({ length: 80 }, (_, i) => `段落 ${i + 1}。読みやすさを確認します。`).join('\n\n') });
    await new Promise(resolve => { releaseScrollMore = resolve; signal.addEventListener('abort', resolve, { once: true }); });
    if (signal.aborted) return;
    emit({ type: 'delta', text: '\n\n追加の段落\n\n' + Array.from({ length: 20 }, (_, i) => `追記 ${i + 1}。`).join('\n\n') });
    await new Promise(resolve => { releaseScrollDone = resolve; signal.addEventListener('abort', resolve, { once: true }); });
    return;
  }
  if (mode === 'slow') {
    emit({ type: 'delta', text: '## 途中の回答\n\n**強調**' });
    await new Promise(resolve => signal.addEventListener('abort', () => { canceled = true; resolve(); }, { once: true })); return;
  }
  emit({ type: 'delta', text: '## ウェブを、もっと落ち着いて読む\n\n' });
  emit({ type: 'delta', text: 'よい道具があれば、**探す時間を減らし、理解するための時間を増やせます。**\n\nページの内容を会話に添えることで、アシスタントは直接答えられます。\n\n### ポイント\n\n- ページを開いたまま質問できる\n- 読み込み済みのコメントも参照できる\n- 続きの質問で理解を深められる\n\n<script>このHTMLは実行されません</script>' });
};
const bridge = createBridge({ token: 'browser-test-only', apiConfigured: true,
  codex: { diagnostics: async () => ({ state: 'ready', message: 'テスト用Codexに接続済みです。' }), models: async () => [{ model: 'codex-test', displayName: 'Codex Test', isDefault: true, inputModalities: ['text', 'image'], supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) }], answer }, apiAnswer: answer });
bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
let context, panel;
try {
  const extension = resolve('test-results/test-extension');
  await cp(resolve('extension'), extension, { recursive: true });
  for (const name of ['panel.js', 'setup.js', 'manifest.json']) {
    const file = resolve(extension, name);
    await writeFile(file, (await readFile(file, 'utf8')).replaceAll('127.0.0.1:4318', '127.0.0.1:' + bridge.address().port));
  }
  // Grant just the local fixture image host. Native permission prompts remain manual;
  // network fetching itself still uses real extension host permission and CSP.
  const manifestPath = resolve(extension, 'manifest.json');
  const testManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  testManifest.host_permissions.push('http://localhost/*');
  await writeFile(manifestPath, JSON.stringify(testManifest));
  context = await chromium.launchPersistentContext(resolve('test-results/browser-profile'), {
    headless: true, channel: 'chromium', executablePath: process.env.CHROMIUM_BIN || undefined,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension], viewport: { width: 390, height: 900 }
  });
  let worker = context.serviceWorkers()[0]; if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  await worker.evaluate(async () => {
    await chrome.storage.local.clear(); await chrome.storage.session.clear();
    await new Promise((resolve, reject) => { const r = indexedDB.deleteDatabase('fast-page-chat'); r.onsuccess = resolve; r.onerror = reject; });
    await chrome.storage.local.set({ settings: { token: 'browser-test-only', provider: 'api', apiModel: 'test-model', privacyConsentVersion: 1, setupCompleted: true } });
  });
  const source = await context.newPage();
  const fixtureBase = 'http://127.0.0.1:' + fixture.address().port;
  await source.goto(fixtureBase + '/article?private=value');
  const fixtureTab = await worker.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url?.includes('/article?')));
  panel = await context.newPage(); const errors = [];
  async function preparePanel(page, targetTabId = fixtureTab.id) {
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(targetId => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async info => {
        if (!info.active) return query(info);
        const tab = await chrome.tabs.get(targetId); delete tab.url; return [tab];
      };
    }, targetTabId);
  }
  await preparePanel(panel);
  await panel.goto('chrome-extension://' + id + '/panel.html');
  const ready = async () => panel.waitForFunction(() => document.querySelector('#source-text').textContent.includes('Shadow text.'));
  const idle = async n => panel.waitForFunction(n => document.querySelectorAll('.assistant').length === n && document.querySelector('#conversation').getAttribute('aria-busy') === 'false', n);
  const close = async () => panel.locator('dialog[open] [data-close]').click();
  const send = async text => { await panel.locator('#question').fill(text); await panel.getByRole('button', { name: '送信', exact: true }).click(); };
  await ready();
  // The optional all-sites request must come from the settings click gesture.
  // Only the native confirmation result is replaced here; the requested scope
  // and denial feedback come from the real panel code.
  await panel.getByRole('button', { name: '設定', exact: true }).click();
  await panel.locator('#page-access-toggle').filter({ hasText: '一度だけ許可する' }).waitFor();
  await panel.evaluate(() => {
    chrome.permissions.request = args => { window.requestedPageOrigins = args.origins; return Promise.resolve(false); };
  });
  await panel.locator('#page-access-toggle').click();
  await panel.locator('#page-access-status').filter({ hasText: 'ブラウザで許可されませんでした' }).waitFor();
  assert.deepEqual(await panel.evaluate(() => window.requestedPageOrigins), ['https://*/*', 'http://*/*']);
  await close();
  assert.equal(await panel.locator('.page-context').count(), 0);
  assert.equal(await panel.getByText('読む時間を、もっと自由に。').count(), 0);
  const extracted = await panel.locator('#source-text').textContent();
  assert.match(extracted, /Loaded comment/); assert.doesNotMatch(extracted, /SECRET|PRIVATE|clutter/);
  assert.doesNotMatch(await panel.locator('#page-url').textContent(), /private/);
  await panel.screenshot({ path: 'test-results/ui-empty-light.png' });

  // Real extraction retains selection support and truncation reporting.
  await source.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('article p')); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await panel.locator('#source-open').click(); await panel.locator('#scope').selectOption('selection');
  await panel.waitForFunction(() => document.querySelector('#source-text').textContent.startsWith('Good tools') && !document.querySelector('#source-text').textContent.includes('Shadow text'));
  await panel.locator('#scope').selectOption('page'); await ready();
  await source.evaluate(() => { const p = document.createElement('p'); p.textContent = 'X'.repeat(61000); document.querySelector('main').append(p); });
  await panel.getByRole('button', { name: '再取得', exact: true }).click();
  await panel.waitForFunction(() => document.querySelector('#source-text').textContent.length === 60000);
  await close();
  assert.equal(await panel.locator('#context-warning').isVisible(), true);
  await source.reload(); await panel.waitForFunction(() => document.querySelector('#source-text').textContent.length < 1000);
  await ready();

  // Skills fill the composer for editing, with no implicit request.
  await panel.getByRole('button', { name: '日本語に翻訳', exact: false }).click();
  assert.equal(count, 0);
  assert.match(await panel.locator('#question').inputValue(), /自然な日本語/);
  await panel.getByRole('button', { name: '送信', exact: true }).click(); await idle(1);
  await panel.waitForFunction(() => document.querySelector('#chat-title').textContent === '最初のAIタイトル');
  assert.equal(titleRequests[0].provider, 'api');
  assert.equal(titleRequests[0].model, 'test-model');
  assert.equal(lastRequest.model, 'test-model'); assert.ok(!JSON.stringify(lastRequest).includes('private=value'));
  assert.equal(await panel.locator('#conversation script').count(), 0);
  assert.equal(await panel.locator('.answer h3').count(), 1);
  assert.ok(await panel.locator('.answer strong').count());
  await panel.screenshot({ path: 'test-results/ui-chat-light.png' });

  // Persisted explicit theme beats OS preference; auto follows OS.
  await panel.getByRole('button', { name: '設定', exact: true }).click();
  assert.equal(await panel.locator('#title-provider').inputValue(), 'same');
  assert.equal(await panel.locator('#title-model-settings').isVisible(), false);
  await panel.locator('#title-provider').selectOption('codex');
  assert.equal(await panel.locator('#title-model').evaluate(element => element.tagName), 'SELECT');
  await panel.locator('#title-model').selectOption('codex-test');
  await panel.locator('#theme').selectOption('dark'); await close();
  assert.equal(await panel.locator('html').getAttribute('data-theme'), 'dark');
  await panel.screenshot({ path: 'test-results/ui-chat-dark.png' });
  await panel.reload(); await idle(1);
  assert.equal(await panel.locator('html').getAttribute('data-theme'), 'dark');
  await source.goto(fixtureBase + '/other');
  await send('根拠をもう少し詳しく'); await idle(2);
  await panel.waitForFunction(() => document.querySelector('#chat-title').textContent === '更新されたAIタイトル');
  assert.equal(titleRequests[1].model, 'codex-test');
  assert.equal(JSON.parse(titleRequests[1].titleInput).messages.at(-2).text, '根拠をもう少し詳しく');
  assert.equal(lastRequest.history.length, 2);
  assert.match(lastRequest.page.text, /Good tools/);
  assert.doesNotMatch(lastRequest.page.text, /different document/);
  // Close the entire panel, then reopen: same conversation and captured source survive.
  await panel.close(); panel = await context.newPage(); await preparePanel(panel);
  await panel.goto('chrome-extension://' + id + '/panel.html'); await idle(2);
  assert.match(await panel.locator('#source-text').textContent(), /Good tools/);

  // Model picker is in composer. API custom model and Codex catalog work.
  await panel.locator('#model-open').click(); await panel.locator('#custom-model').fill('api-model-two');
  await panel.getByRole('button', { name: 'モデルを追加', exact: true }).click();
  await panel.waitForFunction(() => document.querySelector('#model-label').textContent.includes('api-model-two'));
  assert.match(await panel.locator('#model-label').textContent(), /api-model-two/);
  await send('短くまとめて'); await idle(3); assert.equal(lastRequest.model, 'api-model-two');
  await panel.locator('#model-open').click(); await panel.locator('#provider').selectOption('codex');
  await panel.getByRole('button', { name: 'Codex Test', exact: false }).click();
  await panel.locator('#model-dialog').waitFor({ state: 'hidden' });
  await send('別の観点で'); await idle(4); assert.equal(lastRequest.provider, 'codex'); assert.equal(lastRequest.model, 'codex-test');

  // The history action menu floats above the history, and rename edits its row.
  await panel.getByRole('button', { name: 'チャット履歴', exact: true }).click();
  await panel.locator('.history-row .icon-button[title$="の操作"]').first().click();
  assert.equal(await panel.locator('#history-dialog').isVisible(), true);
  assert.equal(await panel.locator('#chat-menu-dialog').isVisible(), true);
  assert.equal(await panel.locator('.history-row.menu-target').count(), 1);
  const menuPlacement = await panel.evaluate(() => {
    const row = document.querySelector('.history-row.menu-target').getBoundingClientRect();
    const menu = document.querySelector('#chat-menu-dialog').getBoundingClientRect();
    return { gap: menu.top - row.bottom, rightGap: Math.abs(menu.right - row.right) };
  });
  assert.ok(menuPlacement.gap >= 0 && menuPlacement.gap <= 16, JSON.stringify(menuPlacement));
  assert.ok(menuPlacement.rightGap <= 16, JSON.stringify(menuPlacement));
  for (const label of ['名前を変更する', 'ピン留めする', 'マークダウンで書き出す', '削除する'])
    assert.equal(await panel.getByRole('button', { name: label, exact: true }).isVisible(), true);
  await panel.screenshot({ path: 'test-results/ui-history-menu.png', animations: 'disabled' });
  await panel.getByRole('button', { name: '名前を変更する', exact: true }).click();
  assert.equal(await panel.locator('#history-dialog').isVisible(), true);
  assert.equal(await panel.locator('#chat-menu-dialog').isVisible(), false);
  await panel.locator('#history-rename-title').fill('リーディングのメモ');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await panel.locator('.history-link').filter({ hasText: 'リーディングのメモ' }).waitFor();
  await panel.locator('.history-row .icon-button[title$="の操作"]').first().click();
  await panel.getByRole('button', { name: 'ピン留めする', exact: true }).click();
  assert.equal(await panel.locator('#history-dialog').isVisible(), true);
  await panel.waitForFunction(() => document.querySelector('.history-group')?.textContent === 'ピン留め');
  await panel.locator('#history-search').fill('リーディング');
  await panel.locator('.history-link').filter({ hasText: 'リーディングのメモ' }).waitFor();
  assert.equal(await panel.locator('.history-group').textContent(), 'ピン留め');
  await panel.screenshot({ path: 'test-results/ui-history.png' });
  await panel.locator('.history-link').click();
  await panel.getByRole('button', { name: 'チャットの操作', exact: true }).click();
  const downloadEvent = panel.waitForEvent('download');
  await panel.getByRole('button', { name: 'マークダウンで書き出す', exact: true }).click();
  const download = await downloadEvent; assert.match(download.suggestedFilename(), /\.md$/);

  // Skill CRUD, reload persistence, invocation and undo.
  await panel.getByRole('button', { name: 'スキル', exact: true }).click();
  await panel.getByRole('button', { name: 'スキルを作成', exact: true }).click();
  await panel.locator('#skill-name').fill('結論と根拠'); await panel.locator('#skill-prompt').fill('結論を1文、根拠を3点で説明してください。');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await panel.getByRole('button', { name: '結論と根拠を編集', exact: true }).click();
  await panel.locator('#skill-prompt').fill('結論と根拠を2点で整理してください。'); await panel.getByRole('button', { name: '保存', exact: true }).click();
  await panel.locator('#skills-dialog').waitFor({ state: 'visible' });
  await panel.screenshot({ path: 'test-results/ui-skills.png' });
  await close(); await panel.reload(); await idle(4);
  await panel.getByRole('button', { name: 'スキル', exact: true }).click();
  await panel.locator('.skill-use').filter({ hasText: '結論と根拠' }).click();
  assert.equal(await panel.locator('#question').inputValue(), '結論と根拠を2点で整理してください。');
  await panel.getByRole('button', { name: 'スキル', exact: true }).click();
  await panel.getByRole('button', { name: '結論と根拠を削除', exact: true }).click();
  await panel.getByRole('button', { name: '元に戻す', exact: true }).click();
  await panel.locator('.skill-use').filter({ hasText: '結論と根拠' }).waitFor(); await close();

  // A stopped response is stored but excluded from subsequent model history.
  mode = 'slow'; await send('停止の確認');
  await panel.locator('.assistant').last().locator('.answer').filter({ hasText: '途中の回答' }).waitFor();
  assert.equal(await panel.locator('.assistant').last().locator('.answer h3').textContent(), '途中の回答');
  assert.equal(await panel.locator('.assistant').last().locator('.answer strong').textContent(), '強調');
  await panel.getByRole('button', { name: '停止', exact: true }).click(); await idle(5);
  assert.equal(canceled, true);
  await panel.reload(); await idle(5); assert.match(await panel.locator('.incomplete').textContent(), /中断/);
  mode = 'normal'; await send('続けて質問'); await idle(6);
  assert.equal(lastRequest.history.length, 8);
  assert.ok(!lastRequest.history.some(m => m.content === '停止の確認'));

  // Real IndexedDB optimistic writes reject stale versions without destroying new data.
  const conflict = await panel.evaluate(async () => {
    const { openStore, createChat } = await import('./chat-store.js'); const store = await openStore();
    const c = createChat({ title: 'Concurrency', url: 'https://example.com', text: 'body' }, 'api', '', 'Concurrent');
    c.revision = await store.saveChat(c); const stale = structuredClone(c);
    c.title = 'Latest'; c.revision = await store.saveChat(c); let rejected = false;
    try { await store.saveChat(stale); } catch { rejected = true; }
    const title = (await store.getChat(c.id)).title; await store.delete('chats', c.id); store.db.close(); return { rejected, title };
  });
  assert.deepEqual(conflict, { rejected: true, title: 'Latest' });

  // Deletion and undo do not delete other records; latest snapshot switches only on new chat.
  await panel.getByRole('button', { name: 'チャットの操作', exact: true }).click();
  await panel.getByRole('button', { name: '削除する', exact: true }).click();
  await panel.getByRole('button', { name: '元に戻す', exact: true }).click();
  await panel.getByRole('button', { name: 'チャット履歴', exact: true }).click();
  await panel.locator('.history-link').filter({ hasText: 'リーディングのメモ' }).click(); await idle(6);
  await panel.getByRole('button', { name: '新しいチャット', exact: true }).click();
  await panel.waitForFunction(() => document.querySelector('#source-text').textContent.includes('different document'));
  await send('新しいページの質問'); await idle(1); assert.match(lastRequest.page.text, /different document/);
  assert.equal(lastRequest.history.length, 0);

  // Layout: explicit light/dark/system, compact widths, keyboard Enter/Shift+Enter.
  for (const theme of ['light', 'dark', 'system']) {
    await panel.getByRole('button', { name: '設定', exact: true }).click();
    await panel.locator('#theme').selectOption(theme); await close();
    for (const width of [320, 390, 520]) {
      await panel.setViewportSize({ width, height: 800 }); await panel.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    const bg = await panel.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(bg, theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(25, 27, 29)');
  }
  await panel.locator('#question').fill('改行'); await panel.locator('#question').press('Shift+Enter');
  assert.equal(await panel.locator('#question').inputValue(), '改行\n');
  await panel.locator('#question').press('Enter'); await idle(2);
  await panel.getByRole('button', { name: '新しいチャット', exact: true }).click();
  // Host permission regression. An existing historical chat would intentionally stay pinned.
  await source.route('http://ungranted.test/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Unpermitted fixture</main>' }));
  await source.goto('http://ungranted.test/article');
  await panel.locator('#status').filter({ hasText: 'アクセス権がありません' }).waitFor();
  await source.goto(fixtureBase + '/article'); await ready();
  assert.deepEqual(errors, []);
  // Browser restart: persistent IndexedDB history and skills survive a fresh process.
  await context.close();
  context = await chromium.launchPersistentContext(resolve('test-results/browser-profile'), {
    headless: true, channel: 'chromium', executablePath: process.env.CHROMIUM_BIN || undefined,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension], viewport: { width: 390, height: 900 }
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const sourceAfterRestart = await context.newPage(); await sourceAfterRestart.goto(fixtureBase + '/article?restart=1');
  const restartedTab = await worker.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url?.includes('restart=1')));
  panel = await context.newPage(); await preparePanel(panel, restartedTab.id);
  await panel.goto('chrome-extension://' + id + '/panel.html'); await ready();
  await panel.getByRole('button', { name: 'チャット履歴', exact: true }).click();
  await panel.locator('.history-link').filter({ hasText: 'リーディングのメモ' }).waitFor();
  assert.equal(await panel.locator('.history-link').count(), 2);
  await panel.screenshot({ path: 'test-results/ui-history.png', animations: 'disabled' });
  await close(); await panel.getByRole('button', { name: 'スキル', exact: true }).click();
  await panel.locator('.skill-use').filter({ hasText: '結論と根拠' }).waitFor();
  await panel.screenshot({ path: 'test-results/ui-skills.png', animations: 'disabled' });
  await close();

  // An image-enabled chat must still send text from a page with no images.
  await panel.locator('#images-toggle').click();
  await panel.waitForFunction(() => document.querySelector('#images-label').textContent === '画像 ON' && document.querySelector('#images-count').textContent === '0枚');
  assert.equal(await panel.locator('#status').isVisible(), false);
  await send('画像のないページを要約して'); await idle(1);
  assert.deepEqual(lastRequest.images, []);
  assert.match(lastRequest.page.text, /Good tools/);
  assert.equal(await panel.locator('#status').isVisible(), false);
  await panel.locator('#images-toggle').click();

  // Real decoded page images, selection, exclusion, image-only documents, and shadow DOM.
  await sourceAfterRestart.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 160;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#16866b'; ctx.fillRect(0, 0, 300, 160); ctx.fillStyle = 'white'; ctx.font = '24px sans-serif'; ctx.fillText('Page diagram', 25, 85);
    const img = document.createElement('img'); img.src = canvas.toDataURL(); img.alt = 'ページの図'; img.id = 'test-image'; document.querySelector('main').prepend(img); await img.decode();
    const hidden = img.cloneNode(); hidden.id = 'hidden-image'; hidden.hidden = true; hidden.alt = 'HIDDEN IMAGE'; document.querySelector('main').append(hidden);
  });
  await panel.locator('#new-chat').click(); await ready();
  await panel.locator('#effort-open').click();
  assert.equal(await panel.locator('#effort-list button').count(), 4);
  await panel.getByRole('button', { name: '高 (high)', exact: true }).click();
  await panel.locator('#effort-dialog').waitFor({ state: 'hidden' });
  await panel.locator('#images-toggle').click();
  await panel.waitForFunction(() => document.querySelector('#images-label').textContent === '画像 ON' && document.querySelector('#images-count').textContent === '1枚');
  assert.equal(await panel.locator('#images-toggle').getAttribute('aria-pressed'), 'true');
  await panel.locator('#images-open').click();
  assert.equal(await panel.locator('#image-preview img').count(), 1);
  await panel.waitForFunction(() => [...document.querySelectorAll('#image-preview img')].every(img => img.complete && img.naturalWidth > 0 && img.getBoundingClientRect().height > 80));
  await panel.screenshot({ path: 'test-results/ui-image-preview.png', animations: 'disabled' }); await close();
  await send('画像の内容を説明して'); await idle(1);
  assert.equal(lastRequest.effort, 'high'); assert.equal(lastRequest.images.length, 1);
  assert.equal(lastRequest.images[0].position, 0);
  assert.match(await panel.locator('#source-text').textContent(), /^\s*\[画像1\]/);
  assert.match(lastRequest.images[0].dataUrl, /^data:image\/jpeg;base64,/);
  assert.ok(!JSON.stringify(lastRequest.page).includes('base64'));
  const savedImage = lastRequest.images[0].dataUrl;
  await panel.reload(); await idle(1);
  assert.match(await panel.locator('#effort-label').textContent(), /高/);
  assert.equal(await panel.locator('#images-count').textContent(), '1枚');
  await panel.locator('#images-toggle').click(); await send('本文だけで答えて'); await idle(2);
  assert.equal(lastRequest.images.length, 0);
  assert.doesNotMatch(await panel.locator('#source-text').textContent(), /\[画像1\]/);
  await sourceAfterRestart.goto(fixtureBase + '/other');
  await panel.locator('#images-toggle').click(); await send('保存した画像をもう一度説明して'); await idle(3);
  assert.equal(lastRequest.images[0].dataUrl, savedImage);
  assert.equal(lastRequest.images[0].position, 0);
  // Cannot silently replace historical images with a different page's image.
  await panel.locator('#images-open').click(); await panel.locator('#images-refresh').click();
  await panel.locator('#image-status').filter({ hasText: 'ページが変わりました' }).waitFor(); await close();
  await panel.locator('#model-open').click(); await panel.locator('#provider').selectOption('api');
  await panel.getByRole('button', { name: 'api-model-two', exact: true }).click();
  await panel.locator('#model-dialog').waitFor({ state: 'hidden' });
  assert.match(await panel.locator('#effort-label').textContent(), /自動/);
  await panel.locator('#effort-open').click(); await panel.getByRole('button', { name: '中 (medium)', exact: true }).click();
  await panel.locator('#effort-dialog').waitFor({ state: 'hidden' });
  await send('APIでも画像を説明して'); await idle(4);
  assert.equal(lastRequest.provider, 'api'); assert.equal(lastRequest.effort, 'medium'); assert.equal(lastRequest.images.length, 1);
  for (const theme of ['light', 'dark']) {
    await panel.locator('#settings-open').click(); await panel.locator('#theme').selectOption(theme); await close();
    await panel.setViewportSize({ width: 320, height: 800 });
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await panel.screenshot({ path: `test-results/ui-images-${theme}.png`, animations: 'disabled' });
  }
  // Reading-order anchors through paragraphs, open shadow roots and slots.
  await sourceAfterRestart.evaluate(async () => {
    document.body.innerHTML = '<main><p id="first">First paragraph.</p><img id="one" alt="First chart"><p id="second">Second paragraph.</p><div id="component"></div><p>Last paragraph.</p></main>';
    const host = document.querySelector('#component'); host.attachShadow({ mode: 'open' }).innerHTML = '<p>Shadow introduction.</p><slot></slot><p>Shadow conclusion.</p>';
    const second = document.createElement('img'); second.alt = 'Second chart'; host.append(second);
    for (const [i, img] of [...document.querySelectorAll('img')].entries()) {
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 140;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = i ? '#112233' : '#ddeeff'; ctx.fillRect(0, 0, 240, 140); img.src = canvas.toDataURL(); await img.decode();
    }
  });
  const positioned = await panel.evaluate(async tabId => {
    const { captureImages } = await import('./images.js'); const { readIdentity } = await import('./page-access.js'); const { pageWithImageMarkers } = await import('./page-context.js');
    const tab = await chrome.tabs.get(tabId), identity = await readIdentity(chrome, tab);
    const result = await captureImages(chrome, tab, identity);
    let rejectsChangedText = false;
    try { await captureImages(chrome, tab, identity, 'page', { ...result.page, text: 'An old, different snapshot' }); } catch (e) { rejectsChangedText = /内容が変わりました/.test(e.message); }
    return { text: pageWithImageMarkers(result.page, result.images).text, images: result.images.map(i => ({ label: i.label, position: i.position })), rejectsChangedText };
  }, restartedTab.id);
  assert.match(positioned.text, /First paragraph\.[\s]*\[画像1\][\s]*Second paragraph\./);
  assert.match(positioned.text, /Shadow introduction\.[\s]*\[画像2\][\s]*Shadow conclusion\./);
  assert.equal(positioned.rejectsChangedText, true);
  await sourceAfterRestart.evaluate(() => { const range = document.createRange(); range.setStartBefore(document.querySelector('#first')); range.setEndAfter(document.querySelector('#second')); getSelection().removeAllRanges(); getSelection().addRange(range); });
  const scoped = await panel.evaluate(async tabId => {
    const { collectImages } = await import('./images.js'); const { extractPage } = await import('./extract.js'); const { pageWithImageMarkers } = await import('./page-context.js');
    const raw = (await chrome.scripting.executeScript({ target: { tabId }, func: collectImages, args: ['selection'] }))[0].result;
    const targets = raw.items.map((item, i) => ({ ...item.target, id: i + 1 }));
    const selected = (await chrome.scripting.executeScript({ target: { tabId }, func: extractPage, args: ['selection', 60000, targets] }))[0].result;
    const truncated = (await chrome.scripting.executeScript({ target: { tabId }, func: extractPage, args: ['page', 5, targets] }))[0].result;
    const images = raw.items.map((item, i) => ({ ...item, position: selected.imagePositions.find(p => p.id === i + 1)?.offset }));
    return { count: raw.items.length, selectionText: pageWithImageMarkers(selected, images).text, truncatedPositions: truncated.imagePositions };
  }, restartedTab.id);
  assert.equal(scoped.count, 1); assert.match(scoped.selectionText, /First paragraph\.[\s]*\[画像1\][\s]*Second paragraph\./);
  assert.deepEqual(scoped.truncatedPositions, []);

  // CORS fallback: use real rendered pixels, with only captureVisibleTab substituted.
  // Toolbar activeTab activation cannot be granted by a headless extension test.
  await sourceAfterRestart.evaluate(async base => {
    document.body.innerHTML = '<main><div style="position:relative;width:240px;height:140px"><img id="background" alt="背景" style="position:absolute;inset:0;width:100%;height:100%;filter:blur(4px);opacity:.3"><img id="external" alt="外部画像" style="position:relative;display:block"></div></main>';
    const url = base.replace('127.0.0.1', 'localhost') + '/picture.svg';
    for (const img of document.querySelectorAll('img')) { img.src = url; await img.decode(); }
  }, fixtureBase);
  const externalScreenshot = 'data:image/png;base64,' + (await sourceAfterRestart.screenshot()).toString('base64');
  const cropped = await panel.evaluate(async ({ tabId, screenshot }) => {
    const { captureImages, collectImages } = await import('./images.js');
    const { readIdentity } = await import('./page-access.js');
    const tab = await chrome.tabs.get(tabId), identity = await readIdentity(chrome, tab);
    const raw = (await chrome.scripting.executeScript({ target: { tabId }, func: collectImages }))[0].result;
    if (raw.items.length !== 1 || !raw.items[0]?.rect || raw.candidates !== 1 || !raw.items[0].label.startsWith('外部画像')) throw new Error('The foreground image must survive a rejected duplicate background image');
    const api = { scripting: chrome.scripting, tabs: { query: chrome.tabs.query, captureVisibleTab: async () => screenshot } };
    const result = await captureImages(api, tab, identity);
    const img = new Image(); img.src = result.images[0].dataUrl; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    return { count: result.images.length, width: img.width, height: img.height, pixel: [...ctx.getImageData(10, 10, 1, 1).data] };
  }, { tabId: restartedTab.id, screenshot: externalScreenshot });
  assert.equal(cropped.count, 1); assert.equal(cropped.width, 240); assert.equal(cropped.height, 140);
  assert.ok(cropped.pixel[0] > 180 && cropped.pixel[1] < 70);
  const imageOnly = await panel.evaluate(async tabId => {
    const { extractPage } = await import('./extract.js');
    return (await chrome.scripting.executeScript({ target: { tabId }, func: extractPage }))[0].result;
  }, restartedTab.id);
  assert.match(imageOnly.text, /画像中心/);

  // Candidate indices differ from adopted image numbers when an earlier image
  // cannot be acquired. Five direct images plus the seventh candidate's crop
  // must fill the six-image limit before the eighth candidate's direct pixels.
  await sourceAfterRestart.evaluate(async base => {
    document.body.innerHTML = '<main></main>';
    const labels = ['Unavailable', 'Direct 1', 'Direct 2', 'Direct 3', 'Direct 4', 'Direct 5', 'Screenshot fallback', 'Later direct'];
    const remote = base.replace('127.0.0.1', 'localhost');
    for (const [index, label] of labels.entries()) {
      const p = document.createElement('p'); p.textContent = 'Before candidate ' + index + '.';
      const img = document.createElement('img'); img.alt = label; img.width = 100; img.height = 60; img.style.display = 'block';
      document.querySelector('main').append(p, img);
      if (index === 0) { img.dataset.src = remote + '/picture.svg?unavailable-mixed'; continue; }
      if (index === 6) img.src = remote + '/picture.svg?crop-mixed';
      else {
        const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 140;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = `rgb(${index * 20},60,180)`; ctx.fillRect(0, 0, 240, 140);
        img.src = canvas.toDataURL('image/png');
      }
      await img.decode();
    }
    scrollTo(0, 0);
  }, fixtureBase);
  const mixedCandidates = await panel.evaluate(async tabId => {
    const { collectImages } = await import('./images.js');
    const raw = (await chrome.scripting.executeScript({ target: { tabId }, func: collectImages }))[0].result;
    return { count: raw.candidates, items: raw.items.map(item => ({ label: item.label, direct: Boolean(item.dataUrl), crop: Boolean(item.rect) })) };
  }, restartedTab.id);
  assert.equal(mixedCandidates.count, 8);
  assert.deepEqual(mixedCandidates.items, [
    { label: 'Unavailable', direct: false, crop: false },
    ...Array.from({ length: 5 }, (_, i) => ({ label: 'Direct ' + (i + 1), direct: true, crop: false })),
    { label: 'Screenshot fallback', direct: false, crop: true },
    { label: 'Later direct', direct: true, crop: false }
  ]);
  const mixedScreenshot = 'data:image/png;base64,' + (await sourceAfterRestart.screenshot()).toString('base64');
  const mixedAcquisition = await panel.evaluate(async ({ tabId, screenshot }) => {
    const { captureImages } = await import('./images.js'), { readIdentity } = await import('./page-access.js');
    const { pageWithImageMarkers } = await import('./page-context.js');
    const tab = await chrome.tabs.get(tabId), identity = await readIdentity(chrome, tab);
    let screenshotCalls = 0;
    // As in the CORS fixture above, only the headless toolbar/screenshot surface
    // is adapted. No external-host permissions means both remote originals fail.
    const api = { scripting: chrome.scripting, tabs: { query: chrome.tabs.query, captureVisibleTab: async () => { screenshotCalls++; return screenshot; } } };
    const result = await captureImages(api, tab, identity, 'page', null, 6);
    const decoded = await Promise.all(result.images.map(async item => {
      const img = new Image(); img.src = item.dataUrl; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
      return { width: img.width, height: img.height, pixel: [...ctx.getImageData(10, 10, 1, 1).data] };
    }));
    return { labels: result.images.map(image => image.label), positions: result.images.map(image => image.position),
      text: result.page.text, marked: pageWithImageMarkers(result.page, result.images).text,
      limit: result.limit, omitted: result.omitted, screenshotCalls, decoded };
  }, { tabId: restartedTab.id, screenshot: mixedScreenshot });
  assert.deepEqual(mixedAcquisition.labels, [...Array.from({ length: 5 }, (_, i) => 'Direct ' + (i + 1)), 'Screenshot fallback（画面に表示された範囲）']);
  assert.equal(mixedAcquisition.limit, 6); assert.equal(mixedAcquisition.omitted, 2);
  assert.equal(mixedAcquisition.screenshotCalls, 1);
  for (let i = 0; i < 6; i++) {
    assert.ok(Number.isInteger(mixedAcquisition.positions[i]));
    assert.ok(mixedAcquisition.text.slice(0, mixedAcquisition.positions[i]).trimEnd().endsWith('Before candidate ' + (i + 1) + '.'));
  }
  assert.match(mixedAcquisition.marked, /Before candidate 6\.[\s]*\[画像6\][\s]*Before candidate 7\./);
  assert.doesNotMatch(mixedAcquisition.marked, /\[画像7\]/);
  for (const [index, image] of mixedAcquisition.decoded.slice(0, 5).entries()) {
    assert.equal(image.width, 240); assert.equal(image.height, 140);
    assert.ok(Math.abs(image.pixel[0] - (index + 1) * 20) <= 5 && Math.abs(image.pixel[1] - 60) <= 5 && Math.abs(image.pixel[2] - 180) <= 5);
  }
  const mixedCrop = mixedAcquisition.decoded[5];
  assert.equal(mixedCrop.width, 100); assert.equal(mixedCrop.height, 60);
  assert.ok(mixedCrop.pixel[0] > 180 && mixedCrop.pixel[1] < 70 && mixedCrop.pixel[2] < 70);
  console.log('PASS: unavailable candidate plus five direct images and a later screenshot crop yields the correct first six images, pixels and paragraph anchors.');

  // Offscreen external pixels, native lazy images and data-src without page scrolling.
  await sourceAfterRestart.evaluate(async base => {
    document.body.innerHTML = '<main><p>Introduction above all diagrams.</p><div style="height:12000px"></div><p>Before offscreen images.</p><img id="loaded" width="240" height="140" alt="Loaded offscreen"><p>Between loaded and lazy.</p><img id="lazy" loading="lazy" width="240" height="140" alt="Lazy offscreen"><p>After lazy diagram.</p><img id="deferred" width="240" height="140" alt="Deferred offscreen"><p>Conclusion.</p></main>';
    const remote = base.replace('127.0.0.1', 'localhost');
    const loaded = document.querySelector('#loaded'); loaded.src = remote + '/picture.svg?loaded'; await loaded.decode();
    document.querySelector('#lazy').src = remote + '/picture.svg?lazy';
    document.querySelector('#deferred').dataset.src = remote + '/picture.svg?deferred';
    scrollTo(0, 0);
  }, fixtureBase);
  assert.equal(await sourceAfterRestart.locator('#lazy').evaluate(img => img.naturalWidth), 0);
  assert.ok(await sourceAfterRestart.locator('#loaded').evaluate(img => img.getBoundingClientRect().top > innerHeight));
  const scrollBefore = await sourceAfterRestart.evaluate(() => [scrollX, scrollY]);
  await context.addCookies([{ name: 'private-test-cookie', value: 'must-not-forward', url: fixtureBase.replace('127.0.0.1', 'localhost') }]);
  imageRequests.length = 0;
  const offscreen = await panel.evaluate(async tabId => {
    const { captureImages } = await import('./images.js'), { readIdentity } = await import('./page-access.js'), { pageWithImageMarkers } = await import('./page-context.js');
    const tab = await chrome.tabs.get(tabId), identity = await readIdentity(chrome, tab);
    const api = { permissions: chrome.permissions, scripting: chrome.scripting, tabs: { query: chrome.tabs.query, captureVisibleTab: () => { throw new Error('Offscreen acquisition must not use a screenshot'); } } };
    const diagnostic = (await chrome.scripting.executeScript({ target: { tabId }, func: () => [...document.images].map(n => ({ label: n.alt, rect: [n.getBoundingClientRect().width, n.getBoundingClientRect().height], natural: n.naturalWidth, src: n.getAttribute('src'), lazy: n.getAttribute('data-src') })) }))[0].result;
    const result = await captureImages(api, tab, identity);
    const decoded = await Promise.all(result.images.map(async item => {
      const image = new Image(); image.src = item.dataUrl; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      return { width: image.width, height: image.height, red: ctx.getImageData(10, 10, 1, 1).data[0] };
    }));
    return { count: result.images.length, labels: result.images.map(i => i.label), diagnostic, text: pageWithImageMarkers(result.page, result.images).text, missing: result.missingOrigins, decoded };
  }, restartedTab.id);
  assert.equal(offscreen.count, 3, JSON.stringify(offscreen)); assert.deepEqual(offscreen.missing, []);
  assert.match(offscreen.text, /Before offscreen images\.[\s]*\[画像1\][\s]*Between loaded and lazy\.[\s]*\[画像2\][\s]*After lazy diagram\.[\s]*\[画像3\][\s]*Conclusion/);
  for (const image of offscreen.decoded) { assert.equal(image.width, 240); assert.equal(image.height, 140); assert.ok(image.red > 180); }
  assert.deepEqual(await sourceAfterRestart.evaluate(() => [scrollX, scrollY]), scrollBefore);
  assert.equal(await sourceAfterRestart.locator('#lazy').evaluate(img => img.naturalWidth), 0, 'must not mutate lazy loading in the source page');
  assert.equal(imageRequests.length, 3);
  assert.ok(imageRequests.every(request => !request.cookie && !request.authorization));

  // Only the OS permission prompt is adapted; the UI discovers the host, retries,
  // and sends the actual acquired pixels through the existing /chat boundary.
  await panel.evaluate(() => {
    const contains = chrome.permissions.contains.bind(chrome.permissions);
    let granted = false;
    chrome.permissions.contains = args => granted ? contains(args) : Promise.resolve(false);
    chrome.permissions.request = async args => { window.requestedImageOrigins = args.origins; granted = true; return true; };
  });
  await panel.locator('#new-chat').click();
  await panel.waitForFunction(() => document.querySelector('#images-count').textContent === '0枚 · 要許可');
  await panel.locator('#images-open').click();
  await panel.locator('#images-authorize').waitFor({ state: 'visible' });
  await panel.screenshot({ path: 'test-results/ui-image-permission.png', animations: 'disabled' });
  await panel.locator('#images-authorize').click();
  await panel.waitForFunction(() => document.querySelectorAll('#image-preview img').length === 3 && document.querySelector('#images-authorize').hidden);
  assert.deepEqual(await panel.evaluate(() => window.requestedImageOrigins), [fixtureBase.replace('127.0.0.1', 'localhost') + '/*']);
  await close(); await send('画面外の画像を含めて説明して'); await idle(1);
  assert.equal(lastRequest.images.length, 3);
  assert.ok(lastRequest.images.every(image => Number.isInteger(image.position) && image.dataUrl.startsWith('data:image/jpeg;base64,')));
  await panel.locator('#images-toggle').click(); await send('画像なしで続けて'); await idle(2);
  assert.equal(lastRequest.images.length, 0);
  console.log('PASS: offscreen CORS originals; native lazy/data-src; real decoded pixels and paragraph anchors; no scrolling/page mutation/cookies; scoped permission UI/retry; actual chat image payload and OFF omission.');
  // Reddit comments can declare width=240 and height=auto while their lazy
  // placeholder is only 20x15px until scrolled into view. The original image
  // must be fetched without scrolling the source page.
  const redditPlaceholder = await sourceAfterRestart.evaluate(base => {
    document.body.innerHTML = '<main><p>Post text.</p><div style="height:12000px"></div><div id="t1_example-post-rtjson-content"><p>Comment text.</p><a><img id="reddit-comment" alt="コメントの画像" width="240" height="auto" loading="lazy" style="width:20px;height:15px;object-fit:cover"></a></div></main>';
    const img = document.querySelector('#reddit-comment');
    img.src = base.replace('127.0.0.1', 'localhost') + '/picture.svg?reddit-comment';
    const rect = img.getBoundingClientRect();
    return { width: rect.width, height: rect.height, naturalWidth: img.naturalWidth, scrollY };
  }, fixtureBase);
  assert.ok(redditPlaceholder.width < 60 && redditPlaceholder.height < 40 && redditPlaceholder.naturalWidth === 0);
  const redditComment = await panel.evaluate(async tabId => {
    const { collectImages, captureImages } = await import('./images.js'), { readIdentity } = await import('./page-access.js');
    const tab = await chrome.tabs.get(tabId), identity = await readIdentity(chrome, tab);
    const raw = (await chrome.scripting.executeScript({ target: { tabId }, func: collectImages }))[0].result;
    const captured = await captureImages(chrome, tab, identity);
    return { candidates: raw.candidates, labels: captured.images.map(image => image.label), missing: captured.missingOrigins, scrollY: (await chrome.scripting.executeScript({ target: { tabId }, func: () => scrollY }))[0].result };
  }, restartedTab.id);
  assert.equal(redditComment.candidates, 1);
  assert.deepEqual(redditComment.labels, ['コメントの画像']);
  assert.deepEqual(redditComment.missing, []);
  assert.equal(redditComment.scrollY, redditPlaceholder.scrollY);
  console.log('PASS: Reddit lazy comment image with width=240/height=auto and a tiny offscreen placeholder is captured without scrolling.');
  // Reddit can replace an image while the extension is encoding earlier images.
  // The stale image must remain available without being anchored to a different
  // DOM node, and it must not prevent the rest of the post from being read.
  await sourceAfterRestart.evaluate(async () => {
    document.body.innerHTML = '<main><p>Post introduction.</p><div><img id="reddit-stable" alt="Stable image" width="240" height="140"></div><p>Between images.</p><div><img id="reddit-changing" alt="Changing image" width="240" height="140"></div><p>Post conclusion.</p></main>';
    for (const [index, img] of [...document.images].entries()) {
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 140;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = index ? '#336699' : '#cc6633'; ctx.fillRect(0, 0, 240, 140);
      img.src = canvas.toDataURL('image/png'); await img.decode();
    }
  });
  const redditReplaced = await panel.evaluate(async tabId => {
    const { captureImages } = await import('./images.js');
    const { readIdentity } = await import('./page-access.js');
    const { pageWithImageMarkers } = await import('./page-context.js');
    const tab = await chrome.tabs.get(tabId), identity = await readIdentity(chrome, tab);
    const executeScript = chrome.scripting.executeScript.bind(chrome.scripting);
    let changed = false;
    const api = { permissions: chrome.permissions, tabs: chrome.tabs, scripting: { executeScript: async injection => {
      if (injection.func.name === 'extractPage' && injection.args?.[2]?.length && !changed) {
        changed = true;
        await executeScript({ target: { tabId }, func: () => {
          const img = document.querySelector('#reddit-changing');
          img.parentNode.insertBefore(document.createElement('span'), img);
          const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 140;
          const ctx = canvas.getContext('2d'); ctx.fillStyle = '#22aa44'; ctx.fillRect(0, 0, 240, 140);
          img.src = canvas.toDataURL('image/png');
        } });
      }
      return executeScript(injection);
    } } };
    const result = await captureImages(api, tab, identity);
    return { changed, text: result.page.text, labels: result.images.map(image => image.label),
      positions: result.images.map(image => image.position), marked: pageWithImageMarkers(result.page, result.images).text };
  }, restartedTab.id);
  assert.equal(redditReplaced.changed, true);
  assert.deepEqual(redditReplaced.labels, ['Stable image', 'Changing image']);
  assert.match(redditReplaced.text, /Post introduction\.[\s\S]*Between images\.[\s\S]*Post conclusion\./);
  assert.ok(Number.isInteger(redditReplaced.positions[0]));
  assert.equal(Number.isInteger(redditReplaced.positions[1]), false);
  assert.match(redditReplaced.marked, /Post introduction\.[\s]*\[画像1\][\s]*Between images\./);
  assert.doesNotMatch(redditReplaced.marked, /\[画像2\]/);
  console.log('PASS: changed Reddit image path/source does not block text or misplace stale image pixels; unchanged image retains its marker.');
  // Amazon search marks visible product links/images aria-hidden for accessibility.
  // That attribute must not hide their pixels from image extraction or lose the
  // marker next to the corresponding product description.
  await sourceAfterRestart.evaluate(async () => {
    document.body.innerHTML = '<main><p>Before product.</p><a aria-hidden="true"><img aria-hidden="true" id="product" width="240" height="140" alt="Visible product"></a><p>Product title and price.</p><p aria-hidden="true">HIDDEN DUPLICATE</p></main>';
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 140;
    canvas.getContext('2d').fillRect(0, 0, 240, 140);
    const img = document.querySelector('#product'); img.src = canvas.toDataURL('image/png'); await img.decode();
  });
  const ariaProduct = await panel.evaluate(async tabId => {
    const { collectImages } = await import('./images.js');
    const { extractPage } = await import('./extract.js');
    const [raw] = await chrome.scripting.executeScript({ target: { tabId }, func: collectImages });
    const target = { ...raw.result.items[0]?.target, id: 1 };
    const [page] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPage, args: ['page', 60000, [target]] });
    return { candidates: raw.result.candidates, label: raw.result.items[0]?.label, text: page.result.text, position: page.result.imagePositions[0]?.offset };
  }, restartedTab.id);
  assert.equal(ariaProduct.candidates, 1);
  assert.equal(ariaProduct.label, 'Visible product');
  assert.doesNotMatch(ariaProduct.text, /HIDDEN DUPLICATE/);
  assert.ok(Number.isInteger(ariaProduct.position) && ariaProduct.position < ariaProduct.text.indexOf('Product title'));
  // Zenn's observed structure: six 26px lazy topic icons precede article .znc,
  // followed by large profile/discussion/promotion images outside the article body.
  await sourceAfterRestart.evaluate(async () => {
    const makeImage = (label, size = 240, lazy = true) => {
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 140;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = label.startsWith('Diagram') ? '#dc2626' : '#123456'; ctx.fillRect(0, 0, 240, 140);
      const img = document.createElement('img'); img.src = canvas.toDataURL() + '#' + label; img.alt = label;
      img.width = size; img.height = size === 26 ? 26 : 140; if (lazy) img.loading = 'lazy'; return img;
    };
    document.body.innerHTML = '<article><div id="topics"></div><div class="znc"><p>Article introduction.</p></div><div id="discussion"></div></article><article id="promotion"></article>';
    for (let i = 0; i < 6; i++) document.querySelector('#topics').append(makeImage('Topic' + i, 26));
    const body = document.querySelector('.znc');
    body.append(makeImage('Inline small icon', 26));
    const collapsed = document.createElement('details'); collapsed.innerHTML = '<summary>Extra explanation</summary>'; collapsed.append(makeImage('Collapsed image', 240, false)); body.append(collapsed);
    for (let i = 1; i <= 8; i++) {
      const p = document.createElement('p'); p.textContent = 'Paragraph ' + i; body.append(p, makeImage('Diagram' + i));
    }
    document.querySelector('#discussion').append(makeImage('Discussion decoration'));
    document.querySelector('#promotion').append(makeImage('Advertisement'));
    await Promise.all([...document.images].map(img => img.decode()));
  });
  const articleImages = await panel.evaluate(async tabId => {
    const { collectImages, captureImages } = await import('./images.js'), { readIdentity } = await import('./page-access.js');
    const tab = await chrome.tabs.get(tabId), identity = await readIdentity(chrome, tab);
    const raw = (await chrome.scripting.executeScript({ target: { tabId }, func: collectImages }))[0].result;
    const captured = await captureImages(chrome, tab, identity);
    return { labels: captured.images.map(i => i.label), positions: captured.images.map(i => i.position), candidates: raw.candidates, text: captured.page.text };
  }, restartedTab.id);
  assert.deepEqual(articleImages.labels, Array.from({ length: 6 }, (_, i) => 'Diagram' + (i + 1)));
  assert.equal(articleImages.candidates, 8);
  for (let i = 0; i < 6; i++) assert.ok(articleImages.text.slice(0, articleImages.positions[i]).trimEnd().endsWith('Paragraph ' + (i + 1)));
  // The setting expands a fresh capture beyond six and caps a saved chat's
  // subsequent payload without deleting its stored images.
  await panel.getByRole('button', { name: '設定', exact: true }).click();
  await panel.locator('#max-images').fill('8'); await panel.locator('#max-images').press('Tab');
  await panel.locator('#max-images-status').filter({ hasText: '最大8枚' }).waitFor();
  assert.equal(await panel.evaluate(async () => (await chrome.storage.local.get('settings')).settings.maxImages), 8);
  await panel.setViewportSize({ width: 320, height: 800 });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await panel.screenshot({ path: 'test-results/ui-image-limit-settings.png', animations: 'disabled' });
  await panel.setViewportSize({ width: 390, height: 900 });
  await close(); await panel.locator('#new-chat').click();
  await panel.locator('#images-toggle').click();
  await panel.waitForFunction(() => document.querySelector('#images-count').textContent === '8枚');
  await send('8枚の図を説明して'); await idle(1);
  assert.equal(lastRequest.images.length, 8);
  await panel.getByRole('button', { name: '設定', exact: true }).click();
  await panel.locator('#max-images').fill('3'); await panel.locator('#max-images').press('Tab');
  await panel.locator('#max-images-status').filter({ hasText: '最大3枚' }).waitFor();
  await panel.locator('#max-images').fill('601'); await panel.locator('#max-images').press('Tab');
  await panel.locator('#max-images-status').filter({ hasText: '1〜600の整数' }).waitFor();
  assert.equal(await panel.locator('#max-images').inputValue(), '3');
  await close();
  await panel.locator('#source-open').click();
  const cappedPreview = await panel.locator('#source-text').textContent();
  assert.match(cappedPreview, /\[画像3\]/); assert.doesNotMatch(cappedPreview, /\[画像4\]/);
  await close(); await send('先頭の図だけ説明して'); await idle(2);
  assert.equal(lastRequest.images.length, 3);
  await panel.locator('#images-open').click();
  assert.match(await panel.locator('#image-status').textContent(), /8枚を保存済み。次の送信には先頭3枚/);
  await close();
  // Exercise the new upper bound through real MV3 capture, saved context,
  // paged preview, HTTP validation, and the provider adapter.
  await panel.getByRole('button', { name: '設定', exact: true }).click();
  await panel.locator('#max-images').fill('600'); await panel.locator('#max-images').press('Tab');
  await panel.locator('#max-images-status').filter({ hasText: '最大600枚' }).waitFor();
  await close();
  await sourceAfterRestart.evaluate(async () => {
    document.body.innerHTML = '<main><p>Six hundred diagrams.</p></main>';
    const fragment = document.createDocumentFragment();
    for (let i = 1; i <= 600; i++) {
      const img = document.createElement('img');
      img.src = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#24677a"/><text x="15" y="45" fill="white">${i}</text></svg>`);
      img.width = 120; img.height = 80; img.alt = 'Diagram ' + i;
      fragment.append(img);
    }
    document.querySelector('main').append(fragment);
    const images = [...document.images];
    for (let start = 0; start < images.length; start += 40) await Promise.all(images.slice(start, start + 40).map(img => img.decode()));
  });
  await panel.locator('#new-chat').click();
  await panel.waitForFunction(() => document.querySelector('#images-count').textContent === '600枚', null, { timeout: 120000 });
  await panel.locator('#images-open').click();
  assert.equal(await panel.locator('#image-preview img').count(), 40);
  await panel.locator('#images-more').click();
  assert.equal(await panel.locator('#image-preview img').count(), 80);
  await close(); await send('図の枚数を教えて'); await idle(1);
  assert.equal(lastRequest.images.length, 600);
  assert.equal(lastRequest.images[599].label, 'Diagram 600');
  await sourceAfterRestart.evaluate(async () => {
    document.body.innerHTML = '<main><p>Large diagram.</p><img id="large-diagram" alt="Large diagram" width="1600" height="1000"></main>';
    const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 1000;
    const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(1600, 1000);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const n = (i * 16777619) >>> 0;
      pixels.data[i] = n & 255; pixels.data[i + 1] = (n >>> 8) & 255; pixels.data[i + 2] = (n >>> 16) & 255; pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    const image = document.querySelector('#large-diagram'); image.src = canvas.toDataURL('image/png'); await image.decode();
  });
  const scaled = await panel.evaluate(async tabId => {
    const { captureImages, collectImages } = await import('./images.js'), { readIdentity } = await import('./page-access.js');
    const tab = await chrome.tabs.get(tabId), identity = await readIdentity(chrome, tab);
    const [raw] = await chrome.scripting.executeScript({ target: { tabId }, func: collectImages, args: ['page', 600, 100000] });
    const result = await captureImages(chrome, tab, identity, 'page', null, 600);
    const img = new Image(); img.src = result.images[0].dataUrl; await img.decode();
    return { count: result.images.length, chars: result.images[0].dataUrl.length, width: img.width, targetChars: JSON.stringify(raw.result.items[0].target).length, url: raw.result.items[0].url };
  }, restartedTab.id);
  assert.equal(scaled.count, 1);
  assert.ok(scaled.chars <= 100000, `large image used ${scaled.chars} characters`);
  assert.ok(scaled.width <= 628, `large image remained ${scaled.width}px wide`);
  assert.ok(scaled.targetChars < 1000 && scaled.url === '');
  // A streamed answer must keep the reader's chosen position, even near the bottom.
  if (await panel.locator('#images-toggle').getAttribute('aria-pressed') === 'true') await panel.locator('#images-toggle').click();
  await panel.waitForFunction(() => document.querySelector('#images-toggle').getAttribute('aria-pressed') === 'false');
  const previousAnswers = await panel.locator('.assistant').count();
  mode = 'scroll'; await send('スクロール位置を確認');
  await panel.locator('.assistant').last().locator('.answer').filter({ hasText: '段落 80' }).waitFor();
  const readingPosition = await panel.evaluate(() => {
    const area = document.querySelector('#scroll-area');
    area.scrollTop = area.scrollHeight - area.clientHeight - 50;
    return area.scrollTop;
  });
  assert.ok(readingPosition > 0, 'streamed answer must overflow the panel');
  releaseScrollMore();
  await panel.locator('.assistant').last().locator('.answer').filter({ hasText: '追加の段落' }).waitFor();
  assert.equal(await panel.evaluate(() => document.querySelector('#scroll-area').scrollTop), readingPosition);
  releaseScrollDone(); await idle(previousAnswers + 1);
  assert.equal(await panel.evaluate(() => document.querySelector('#scroll-area').scrollTop), readingPosition);
  mode = 'normal';
  console.log('PASS: configurable 600-image maximum; real MV3 capture, paged preview, and 600-image API payload.');
  console.log('PASS: Zenn article body; small lazy icons excluded; promotions/profile decorations excluded; first six body diagrams and paragraph anchors.');
  assert.deepEqual(errors, []);
  console.log('PASS: real MV3 extraction/permissions; Markdown/XSS; all themes/widths; API/Codex model picker; skill CRUD/undo; persistent history/reopen/search/pin/rename/export/delete/undo; frozen source isolation; interrupted turns; optimistic conflict detection; keyboard submission.');
  console.log('Model responses mocked; browser toolbar activation remains a manual check.');
  console.log('PASS: effort selection/model reset/persistence; image ON/OFF and payload omission; previews; saved-image isolation; API/Codex image requests; CORS image cropping with screenshot adapter; image-only pages.');
} catch (error) {
  if (panel && !panel.isClosed()) {
    await panel.screenshot({ path: 'test-results/ui-failure.png' }).catch(() => {});
    console.log(await panel.locator('#status').textContent());
    console.log(await panel.locator('#model-status').textContent());
  }
  throw error;
} finally {
  await context?.close(); fixture.closeAllConnections(); fixture.close(); bridge.closeAllConnections(); bridge.close();
}
