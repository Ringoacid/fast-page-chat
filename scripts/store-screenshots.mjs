// Capture the actual extension UI beside a local sample article for store assets.
// The article and responses are explicit demonstration content. No real AI calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBridge } from '../server/http.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const article = `<!doctype html><html lang="en"><meta charset="UTF-8"><title>A quieter way to read the web</title><style>
*{box-sizing:border-box}body{margin:0;background:#f7f8f5;color:#202d28;font:16px/1.75 Georgia,serif}main{padding:44px 60px;max-width:780px;margin:auto}.eyebrow{font:600 12px/1.4 system-ui;letter-spacing:2px;color:#487363}.line{width:40px;height:3px;background:#1b7d68;margin:22px 0}h1{font-size:40px;line-height:1.17;letter-spacing:-1.4px;margin:18px 0 28px;font-weight:500}h2{font-size:25px;font-weight:500;margin-top:32px}p{margin:18px 0;color:#40534a}.lead{font-size:21px}.note{margin-top:34px;border-top:1px solid #d9e3dc;padding-top:20px;font:12px/1.8 system-ui;color:#587164}strong{color:#202d28}
</style><main><div class="eyebrow">SAMPLE ARTICLE · READING &amp; TOOLS</div><div class="line"></div><h1>A quieter way<br>to read the web</h1><p class="lead">Good tools help us spend less time searching and more time understanding.</p><p>Reading on the web often means moving between an article, a translation tool, and a separate chat window. Each switch can make it harder to keep track of the original idea.</p><h2>Keep the source close</h2><p>Bringing the page into the conversation lets us ask a question while the original text stays in view. A short summary provides a starting point; follow-up questions help us explore the details.</p><p><strong>Choose what to share.</strong> Review the extracted text, include images only when useful, and keep the conversation tied to the page you started with.</p><p class="note" lang="ja">サンプル記事・デモ応答を使用しています。<br>右側は実際のFast Page Chatの画面です。</p></main></html>`;
const fixture = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(article); });
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
const answer = async (request, emit) => emit({ type: 'delta', text: request.titleInput ? 'ページを見ながら理解する' : '## 記事の要点\n\n元のページを見ながら、翻訳・要約・質問を続けることで、内容を理解しやすくするという記事です。\n\n### 大切な3つのこと\n\n- **読むことに集中する** — 記事と別のツールを何度も行き来する手間を減らす。\n- **会話で理解を深める** — 要約を入口に、気になった点を追加で質問する。\n- **共有する内容を選ぶ** — 取得した本文を確認し、画像は必要なときだけ含める。' });
const bridge = createBridge({ token: 'store-demo-token', apiConfigured: true, codex: { diagnostics: async () => ({ state: 'signed_out', message: 'Codexにログインしてください。' }), models: async () => [], answer }, apiAnswer: answer });
bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
let context;
try {
  const extension = resolve('test-results/store-extension');
  await mkdir('docs/assets', { recursive: true }); await cp(resolve('extension'), extension, { recursive: true });
  const setupPath = resolve(extension, 'setup.js');
  await writeFile(setupPath, (await readFile(setupPath, 'utf8')).replaceAll('127.0.0.1:4318', '127.0.0.1:' + bridge.address().port));
  const fixtureUrl = 'http://127.0.0.1:' + fixture.address().port + '/sample-article';
  await writeFile(resolve(extension, 'store-preview.html'), `<!doctype html><html lang="ja"><meta charset="UTF-8"><title>Fast Page Chat - 公開用スクリーンショット</title><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;font-family:system-ui;background:#f7f8f5}.caption{height:48px;display:flex;align-items:center;padding:0 24px;gap:12px;background:#fff;border-bottom:1px solid #dfe5e1;color:#315047;font-size:13px}.caption strong{font-size:15px;color:#202d28}.caption img{width:24px;height:24px}.caption .demo{margin-left:auto;font-size:11px;color:#6c7972}.views{display:grid;grid-template-columns:minmax(0,1fr) 440px;height:calc(100% - 48px)}iframe{width:100%;height:100%;border:0}.panel{border-left:1px solid #d8e0db;box-shadow:-4px 0 18px #12321f06}</style><header class="caption"><img src="icons/icon-32.png" alt=""><strong>Fast Page Chat</strong><span>ページを見ながら、日本語で理解する</span><span class="demo">サンプル記事・デモ応答</span></header><div class="views"><iframe src="${fixtureUrl}" title="サンプル記事"></iframe><iframe class="panel" src="panel.html" title="Fast Page Chatの実際の画面"></iframe></div></html>`);
  context = await chromium.launchPersistentContext(resolve('test-results/store-profile-' + Date.now()), {
    headless: true, channel: 'chromium', executablePath: process.env.CHROMIUM_BIN || undefined,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension], viewport: { width: 1280, height: 800 }
  });
  context.setDefaultTimeout(15000);
  let worker = context.serviceWorkers()[0]; if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const source = await context.newPage(); await source.goto(fixtureUrl);
  const sourceTab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), fixtureUrl);
  await worker.evaluate(async () => chrome.storage.local.set({ settings: { token: 'store-demo-token', provider: 'api', apiModel: 'demo-model', privacyConsentVersion: 1, setupCompleted: true, theme: 'light' } }));
  const preview = await context.newPage(), errors = [];
  preview.on('pageerror', error => errors.push(error.message));
  await preview.addInitScript(targetId => {
    if (!globalThis.chrome?.tabs) return;
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async info => info.active ? [await chrome.tabs.get(targetId)] : query(info);
  }, sourceTab.id);
  await preview.goto('chrome-extension://' + id + '/store-preview.html');
  let panel = preview.frameLocator('iframe.panel');
  await panel.locator('#source-text').filter({ hasText: 'Good tools' }).waitFor({ state: 'attached' });
  await panel.locator('#question').fill('この記事の要点を日本語でまとめて'); await panel.locator('#send').click();
  await panel.locator('#chat-title').filter({ hasText: 'ページを見ながら理解する' }).waitFor();
  await panel.locator('#scroll-area').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await preview.screenshot({ path: 'docs/assets/store-chat.png', animations: 'disabled' });
  await preview.close();
  await worker.evaluate(async () => {
    await chrome.storage.local.remove('settings'); await chrome.storage.session.clear();
  });
  const setupPreview = await context.newPage(); setupPreview.on('pageerror', error => errors.push(error.message));
  await setupPreview.goto('chrome-extension://' + id + '/store-preview.html');
  panel = setupPreview.frameLocator('iframe.panel');
  await panel.locator('#setup-consent').waitFor({ state: 'visible' });
  await setupPreview.screenshot({ path: 'docs/assets/store-onboarding.png', animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log('Created 1280x800 store-chat.png and store-onboarding.png from the actual extension documents with disclosed local demo content.');
} finally { await context?.close(); fixture.closeAllConnections(); fixture.close(); bridge.closeAllConnections(); bridge.close(); }
