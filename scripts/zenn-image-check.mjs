// Optional live smoke test of the reported public article. No model requests.
// Uses an isolated profile/extension; never touches the user's browser or history.
import assert from 'node:assert/strict';
import { cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const url = 'https://zenn.dev/ringo_acid/articles/5519bb81afa734';
const extension = resolve('test-results/zenn-live-extension');
await mkdir(extension, { recursive: true });
await cp(resolve('extension'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['https://zenn.dev/*', 'https://static.zenn.studio/*'];
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
await writeFile(resolve(extension, 'image-check.html'), '<!doctype html><title>Isolated image test</title>');
const context = await chromium.launchPersistentContext(resolve('test-results/zenn-live-profile'), {
  headless: true, channel: 'chromium', executablePath: process.env.CHROMIUM_BIN || undefined,
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension], viewport: { width: 1280, height: 900 }
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage(); await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('article .znc img').first().waitFor();
  const expected = await page.evaluate(() => [...document.querySelectorAll('article .znc img')].filter(img => !img.closest('button,details:not([open])')).slice(0, 6).map(img => img.src));
  assert.equal(expected.length, 6);
  const tab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), url);
  const panel = await context.newPage(); await panel.goto('chrome-extension://' + id + '/image-check.html');
  const captured = await panel.evaluate(async tabId => {
    const { collectImages, captureImages } = await import('./images.js');
    const { readIdentity } = await import('./page-access.js');
    const tab = await chrome.tabs.get(tabId), identity = await readIdentity(chrome, tab);
    const raw = (await chrome.scripting.executeScript({ target: { tabId }, func: collectImages }))[0].result;
    const api = { permissions: chrome.permissions, scripting: chrome.scripting, tabs: { query: async () => [tab], captureVisibleTab: () => { throw new Error('Original article images should not need screenshots'); } } };
    const result = await captureImages(api, tab, identity);
    const dimensions = await Promise.all(result.images.map(async item => {
      const image = new Image(); image.src = item.dataUrl; await image.decode(); return [image.width, image.height];
    }));
    return { urls: raw.items.slice(0, 6).map(item => item.url), count: result.images.length, positions: result.images.map(item => item.position), missing: result.missingOrigins, dimensions };
  }, tab.id);
  assert.deepEqual(captured.urls, expected);
  assert.equal(captured.count, 6); assert.deepEqual(captured.missing, []);
  assert.ok(captured.positions.every(Number.isInteger));
  assert.ok(captured.dimensions.every(([w, h]) => w > 80 && h > 60));
  console.log('PASS: live Zenn article; six actual body diagrams downloaded and decoded, no topic icons, original DOM positions preserved.');
  console.log(JSON.stringify(captured));
} finally { await context.close(); }
