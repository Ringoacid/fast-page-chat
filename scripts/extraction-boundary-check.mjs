// Deterministic, synthetic MV3 regressions for page-extraction boundaries.
// This is separate from live-site evidence: every page here is a local fixture.
// No real model requests, login, or user browser profile is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const output = resolve('test-results/extraction-boundary');
await mkdir(output, { recursive: true });
const extension = await mkdtemp(resolve(output, 'extension-'));
const profile = await mkdtemp(resolve(output, 'profile-'));
await cp(resolve('extension'), extension, { recursive: true });
await writeFile(resolve(extension, 'boundary-check.html'), '<!doctype html><title>Extraction boundary check</title>');
// Chromium may report an injected exception without rejecting executeScript.
// Emit a static test-only wrapper so the actual MV3 function's error is observable.
const extractionSource = await readFile(resolve(extension, 'extract.js'), 'utf8');
await writeFile(resolve(extension, 'boundary-errors.js'), 'export function extractWithError() {\n' + extractionSource.replace(/^export function extractPage/m, 'function extractPage') + '\ntry { return { value: extractPage() }; } catch (error) { return { error: error.message }; }\n}\n');
let hasBefore = true;
try { await cp(resolve('.research/release-audit/extract-before.js'), resolve(extension, 'extract-before.js')); }
catch (error) { if (error.code === 'ENOENT') hasBefore = false; else throw error; }
const fixture = createServer((request, response) => {
  if (request.url.startsWith('/image.svg')) {
    response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="140"><rect width="240" height="140" fill="#2563eb"/><text x="20" y="80" fill="white">Local test image</text></svg>');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Synthetic extraction boundary fixture</title><style>body{font:18px sans-serif}img{width:240px;height:140px}</style><body></body>');
});
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');
let context;
const checks = [];
const evidence = [];
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium', executablePath: process.env.CHROMIUM_BIN || undefined,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
    viewport: { width: 1280, height: 900 }
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const source = await context.newPage();
  await source.goto('http://127.0.0.1:' + fixture.address().port + '/fixture');
  const tab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(item => item.url === url), source.url());
  const panel = await context.newPage();
  await panel.goto('chrome-extension://' + extensionId + '/boundary-check.html');
  const setFixture = async html => {
    await source.evaluate(html => { document.body.innerHTML = html; window.scrollTo(0, 0); getSelection().removeAllRanges(); }, html);
    await source.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
  };
  const extract = async (scope = 'page') => panel.evaluate(async ({ tabId, hasBefore, scope }) => {
    const { extractPage } = await import('./extract.js');
    const { collectImages } = await import('./images.js');
    const images = (await chrome.scripting.executeScript({ target: { tabId }, func: collectImages, args: [scope] }))[0].result;
    const targets = images.items.map((item, index) => ({ ...item.target, id: 'image-' + index }));
    const after = (await chrome.scripting.executeScript({ target: { tabId }, func: extractPage, args: [scope, 60000, targets] }))[0].result;
    let before;
    if (hasBefore) {
      const { extractPage: oldExtractPage } = await import('./extract-before.js');
      before = (await chrome.scripting.executeScript({ target: { tabId }, func: oldExtractPage, args: [scope] }))[0].result;
    }
    return { after, before, images: { candidates: images.candidates, viewport: images.viewport, labels: images.items.map(item => item.label) } };
  }, { tabId: tab.id, hasBefore, scope });
  const record = (name, details = {}) => { checks.push({ name, passed: true, ...details }); console.log('PASS: ' + name); };

  await setFixture(`<main><h1>VISIBLE_ARTICLE</h1><p>Article introduction.</p>
    <div contenteditable="">DRAFT_EMPTY<img src="/image.svg?draft-empty" alt="draft-empty"></div>
    <div contenteditable="plaintext-only"><span id="selected-draft">DRAFT_PLAINTEXT</span><img src="/image.svg?draft-plain" alt="draft-plain"></div>
    <div contenteditable="true"><span>DRAFT_INHERITED</span><div contenteditable="false">DRAFT_FALSE_CHILD<img src="/image.svg?draft-false" alt="draft-false"></div></div>
    <div style="height:7000px"></div><section id="comment"><p>LOADED_OFFSCREEN_COMMENT</p><img id="comment-image" src="/image.svg?comment" alt="comment-image"></section>
    <details><summary>Closed discussion</summary><p>CLOSED_DISCUSSION_COMMENT</p></details><p>AFTER_IMAGE</p></main>`);
  const positionsBefore = await source.evaluate(() => ({ scrollY, commentTop: document.querySelector('#comment').getBoundingClientRect().top, imageTop: document.querySelector('#comment-image').getBoundingClientRect().top, viewportHeight: innerHeight }));
  assert.ok(positionsBefore.commentTop > positionsBefore.viewportHeight);
  assert.ok(positionsBefore.imageTop > positionsBefore.viewportHeight);
  const ordinary = await extract();
  assert.doesNotMatch(ordinary.after.text, /DRAFT_/);
  assert.deepEqual(ordinary.images.labels, ['comment-image']);
  record('Empty/plaintext-only/inherited editors and false children do not leak text or images');
  assert.match(ordinary.after.text, /LOADED_OFFSCREEN_COMMENT/);
  assert.equal(ordinary.images.candidates, 1);
  assert.equal(await source.evaluate(() => scrollY), positionsBefore.scrollY);
  record('Loaded comments and images below the viewport survive without scrolling', positionsBefore);
  assert.match(ordinary.after.text, /CLOSED_DISCUSSION_COMMENT/);
  record('Closed details discussion text remains readable');
  assert.equal(ordinary.after.imagePositions.length, 1);
  const marker = ordinary.after.imagePositions[0];
  assert.equal(marker.id, 'image-0');
  assert.ok(marker.offset > ordinary.after.text.indexOf('LOADED_OFFSCREEN_COMMENT'));
  assert.ok(marker.offset <= ordinary.after.text.indexOf('CLOSED_DISCUSSION_COMMENT'));
  record('Image marker remains anchored after its offscreen comment');
  evidence.push({ name: 'editor and offscreen fixture', positionsBefore, ...ordinary });
  await source.screenshot({ path: resolve(output, 'offscreen-fixture.png') });
  await source.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('#selected-draft')); getSelection().removeAllRanges(); getSelection().addRange(range); });
  const selected = await extract('selection');
  assert.equal(selected.after.text, 'DRAFT_PLAINTEXT');
  record('Explicit user text selection can still capture a draft');

  const excludedAncestors = [
    ['display:none', 'style="display:none"'], ['hidden', 'hidden'], ['aria-hidden', 'aria-hidden="true"'],
    ['dialog', 'role="dialog"'], ['navigation role', 'role="navigation"'], ['empty editor', 'contenteditable=""'], ['plaintext editor', 'contenteditable="plaintext-only"'],
    ['noneditable main within editor', 'contenteditable="true"']
  ];
  for (const [name, attributes] of excludedAncestors) {
    await setFixture(`<main><h1>VISIBLE_ARTICLE</h1><p>Visible article text.</p><img src="/image.svg?visible" alt="visible-image"></main>
      <div ${attributes}><main contenteditable="false"><p>${('EXCLUDED_ROOT_' + name + ' ').repeat(100)}</p><img src="/image.svg?excluded" alt="excluded-image"></main></div>`);
    const result = await extract();
    assert.match(result.after.text, /VISIBLE_ARTICLE/);
    assert.doesNotMatch(result.after.text, /EXCLUDED_ROOT/);
    assert.deepEqual(result.images.labels, ['visible-image']);
    record(`A longer main inside ${name} cannot replace the readable article`);
    evidence.push({ name: 'ancestor ' + name, ...result });
  }
  for (const mode of ['hidden', 'editor']) {
    await setFixture(`<main><p>VISIBLE_ARTICLE</p><img src="/image.svg?visible-slot" alt="visible-image"></main>
      <div id="shadow-host"><main slot="blocked"><p>${'EXCLUDED_SLOTTED_ROOT '.repeat(100)}</p><img src="/image.svg?excluded-slot" alt="excluded-image"></main></div>`);
    await source.evaluate(mode => {
      const shadow = document.querySelector('#shadow-host').attachShadow({ mode: 'open' });
      shadow.innerHTML = `<div ${mode === 'hidden' ? 'style="display:none"' : 'contenteditable=""'}><slot name="blocked"></slot></div>`;
    }, mode);
    const result = await extract();
    assert.match(result.after.text, /VISIBLE_ARTICLE/);
    assert.doesNotMatch(result.after.text, /EXCLUDED_SLOTTED_ROOT/);
    assert.deepEqual(result.images.labels, ['visible-image']);
    record(`Slotted main follows its ${mode} shadow ancestor`);
    evidence.push({ name: 'slot ' + mode, ...result });
  }
  await setFixture('<main><p>VISIBLE_ARTICLE</p><div aria-hidden="true"><img src="/image.svg?aria-visible" alt="visible-product-image"><p>ARIA_HIDDEN_LABEL</p></div><p>AFTER_IMAGE</p></main>');
  const ariaImage = await extract();
  assert.doesNotMatch(ariaImage.after.text, /ARIA_HIDDEN_LABEL/);
  assert.deepEqual(ariaImage.images.labels, ['visible-product-image']);
  assert.deepEqual(ariaImage.after.imagePositions, [{ id: 'image-0', offset: 'VISIBLE_ARTICLE'.length }]);
  record('Rendered aria-hidden image inside the readable article retains its marker');
  evidence.push({ name: 'rendered aria-hidden image', ...ariaImage });
  await setFixture('<main><p>HIDDEN_HTML_ARTICLE</p><img src="/image.svg?html-hidden" alt="html-hidden-image"></main>');
  const originalHtmlStyle = await source.evaluate(() => document.documentElement.getAttribute('style'));
  try {
    await source.evaluate(() => { document.documentElement.style.display = 'none'; });
    const extractionFailure = await panel.evaluate(async tabId => {
      const { extractWithError } = await import('./boundary-errors.js');
      return (await chrome.scripting.executeScript({ target: { tabId }, func: extractWithError }))[0].result;
    }, tab.id);
    assert.match(extractionFailure.error, /本文を取得できません/);
    assert.equal(extractionFailure.value, undefined);
    const hiddenImages = await panel.evaluate(async tabId => {
      const { collectImages } = await import('./images.js');
      const result = (await chrome.scripting.executeScript({ target: { tabId }, func: collectImages }))[0].result;
      return { candidates: result.candidates, items: result.items };
    }, tab.id);
    assert.deepEqual(hiddenImages, { candidates: 0, items: [] });
    record('Hidden html ancestor cannot leak through the body fallback or image placeholder');
    evidence.push({ name: 'hidden html fallback', extractionError: extractionFailure.error, images: hiddenImages });
  } finally {
    await source.evaluate(originalStyle => {
      if (originalStyle === null) document.documentElement.removeAttribute('style');
      else document.documentElement.setAttribute('style', originalStyle);
    }, originalHtmlStyle);
  }
  const oldLeaks = hasBefore ? evidence.filter(item => /DRAFT_|EXCLUDED_ROOT|EXCLUDED_SLOTTED_ROOT/.test(item.before?.text || '')).map(item => item.name) : [];
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ scope: 'Synthetic local fixture regression checks, not live-site observations.', checkedAt: new Date().toISOString(), passed: checks.length, checks, oldVersionAvailable: hasBefore, oldVersionLeaks: oldLeaks, evidence }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, oldVersionLeaks: oldLeaks }));
} finally {
  if (context) await context.close();
  await new Promise(resolve => fixture.close(resolve));
}
