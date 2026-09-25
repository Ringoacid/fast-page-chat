// Live, read-only Reddit probe with an isolated MV3 extension and browser profile.
// A challenge/login block is recorded as unverified, never as a passing check.
// No login, posting, AI requests, CAPTCHA solving, stealth, or user profile access.
// PLAYWRIGHT_MODULE and CHROMIUM_BIN may point to host-installed dependencies.
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const output = resolve('test-results/reddit-content');
await mkdir(output, { recursive: true });
const extension = await mkdtemp(resolve(output, 'extension-'));
const profile = await mkdtemp(resolve(output, 'profile-'));
await cp(resolve('extension'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['https://www.reddit.com/*', 'https://old.reddit.com/*'];
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
await writeFile(resolve(extension, 'content-check.html'), '<!doctype html><title>Isolated content check</title>');
let hasBefore = true;
try { await cp(resolve('.research/release-audit/extract-before.js'), resolve(extension, 'extract-before.js')); }
catch (error) { if (error.code === 'ENOENT') hasBefore = false; else throw error; }
const urls = process.argv.slice(2);
if (!urls.length) urls.push(
  'https://www.reddit.com/r/photography/comments/1wjm09b/official_question_thread_ask_rphotography/',
  'https://old.reddit.com/r/photography/comments/1wjm09b/official_question_thread_ask_rphotography/'
);
const context = await chromium.launchPersistentContext(profile, {
  headless: true, channel: 'chromium', executablePath: process.env.CHROMIUM_BIN || undefined,
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
  viewport: { width: 1280, height: 900 }
});
const results = [];
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto('chrome-extension://' + extensionId + '/content-check.html');
  for (const [index, url] of urls.entries()) {
    const page = await context.newPage();
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 20000 }).catch(() => {});
      const observed = await page.evaluate(() => ({
        url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight, scrollY },
        bodyPreview: document.body.innerText.slice(0, 1200),
        commentElements: document.querySelectorAll('shreddit-comment,.comment').length,
        mains: [...document.querySelectorAll('main,[role="main"]')].map(node => ({ tag: node.tagName, id: node.id, chars: node.innerText.length })),
        editableKinds: [...document.querySelectorAll('[contenteditable],textarea,input')].map(node => ({ tag: node.tagName, type: node.getAttribute('type'), contenteditable: node.getAttribute('contenteditable') }))
      }));
      const blocked = /prove your humanity|blocked by network security|whoa there, pardner|you've been blocked/i.test(observed.title + '\n' + observed.bodyPreview) || response?.status() === 403;
      const result = { requestedUrl: url, httpStatus: response?.status(), checkedAt: new Date().toISOString(), ...observed };
      if (blocked) {
        result.outcome = 'blocked';
        result.verified = false;
        result.reason = 'Reddit displayed a challenge or network security block. Article, comments, images, and draft exclusion could not be checked.';
      } else {
        const tab = await worker.evaluate(async currentUrl => (await chrome.tabs.query({})).find(item => item.url === currentUrl), page.url());
        if (!tab) throw new Error('Could not identify the isolated Reddit tab.');
        result.extraction = await panel.evaluate(async ({ tabId, hasBefore }) => {
          const { extractPage } = await import('./extract.js');
          const { collectImages } = await import('./images.js');
          const after = (await chrome.scripting.executeScript({ target: { tabId }, func: extractPage }))[0].result;
          const rawImages = (await chrome.scripting.executeScript({ target: { tabId }, func: collectImages, args: ['page', 600] }))[0].result;
          let before;
          if (hasBefore) {
            const { extractPage: oldExtractPage } = await import('./extract-before.js');
            before = (await chrome.scripting.executeScript({ target: { tabId }, func: oldExtractPage }))[0].result;
          }
          return { before, after, images: { ...rawImages, items: rawImages.items.map(({ dataUrl, ...item }) => ({ ...item, embeddedDataChars: dataUrl?.length || 0 })) } };
        }, { tabId: tab.id, hasBefore });
        result.outcome = 'observed';
        result.verified = false;
        result.reason = 'Extraction collected for manual comparison; this probe does not treat an unreviewed page as a passed regression check.';
      }
      await page.screenshot({ path: resolve(output, `live-${index}.png`) });
      result.screenshot = `live-${index}.png`;
      results.push(result);
      console.log(JSON.stringify({ url: result.url, httpStatus: result.httpStatus, title: result.title, comments: result.commentElements, outcome: result.outcome, reason: result.reason }));
    } catch (error) {
      results.push({ requestedUrl: url, outcome: 'error', verified: false, error: String(error) });
      console.log(JSON.stringify({ url, outcome: 'error', error: String(error) }));
    } finally { await page.close(); }
  }
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ scope: 'Unmodified live Reddit pages only; no synthetic DOM or user drafts inserted.', results }, null, 2));
} finally { await context.close(); }
