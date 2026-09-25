// Live regression check using publicly readable articles in an isolated MV3 profile.
// No login, editor mutation, posting, model calls, or access to the user's browser.
// Selectors and interaction paths were first observed on the live pages.
import assert from 'node:assert/strict';
import { cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const out = resolve('test-results/zenn-note-content');
const extension = resolve(out, 'extension');
await mkdir(extension, { recursive: true });
await cp(resolve('extension'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['https://zenn.dev/*', 'https://static.zenn.studio/*', 'https://note.com/*', 'https://assets.st-note.com/*'];
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
let baselineAvailable = true;
try { await cp(resolve('.research/release-audit/extract-before.js'), resolve(extension, 'extract-before.js')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  baselineAvailable = false;
  await cp(resolve('extension/extract.js'), resolve(extension, 'extract-before.js'));
}
await writeFile(resolve(extension, 'live-check.html'), '<!doctype html><title>Isolated live extraction check</title>');
// Run both pure extractors in one browser task so asynchronous site hydration
// cannot change the DOM between the baseline and current snapshots.
const beforeSource = (await readFile(resolve(extension,'extract-before.js'),'utf8')).replace('export function extractPage','function beforeExtractPage');
const afterSource = (await readFile(resolve(extension,'extract.js'),'utf8')).replace('export function extractPage','function currentExtractPage');
await writeFile(resolve(extension,'compare-extract.js'), beforeSource + '\n' + afterSource + '\nglobalThis.__fastPageAuditCompare = () => ({before: beforeExtractPage(), after: currentExtractPage()});\n');
const context = await chromium.launchPersistentContext(resolve(out, 'profile-' + Date.now()), {
  headless: true, channel: 'chromium', executablePath: process.env.CHROMIUM_BIN || undefined,
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension], viewport: { width: 1280, height: 900 }
});
const sites = [
  { name: 'zenn', url: 'https://zenn.dev/2ndillness/articles/85421a8dadebe6', comments: '[id^="comment-"] .znc', expectComments: 5 },
  { name: 'note-old', url: 'https://note.com/nice_hawk867/n/n184c337d04da', comments: '.o-commentAreaCommentItem__comment', open: 'button.o-viewComment' },
];
const reports = [];
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const panel = await context.newPage(); await panel.goto('chrome-extension://' + id + '/live-check.html');
  const extract = tabId => panel.evaluate(async tabId => {
    await chrome.scripting.executeScript({target:{tabId},files:['compare-extract.js']});
    return (await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.__fastPageAuditCompare() }))[0].result;
  }, tabId);
  const observe = (page, selector) => page.evaluate(selector => ({
    scrollY, viewport: innerHeight,
    editors: document.querySelectorAll('[contenteditable],textarea,[role="textbox"]').length,
    comments: selector ? [...document.querySelectorAll(selector)].map(n => ({
      text: n.innerText.replace(/\nもっとみる\s*$/, '').replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
      top: n.getBoundingClientRect().top, height: n.getBoundingClientRect().height,
      overflow: getComputedStyle(n).overflow, lineClamp: getComputedStyle(n).webkitLineClamp
    })) : [],
    images: [...document.querySelectorAll('article img')].map(n => ({src: n.currentSrc || n.src, top: n.getBoundingClientRect().top, width: n.width, height: n.height, naturalWidth: n.naturalWidth, loading: n.loading}))
  }), selector);
  for (const site of sites) {
    const page = await context.newPage();
    await page.goto(site.url, { waitUntil: 'domcontentloaded' });
    await page.locator('article').first().waitFor({ state: 'attached' });
    if (site.open) await page.locator(site.open).waitFor();
    if (site.expectComments && !site.open) await page.locator(site.comments).first().waitFor({state:'attached'});
    const tab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url), site.url);
    const initial = await observe(page, site.comments);
    const initialExtract = await extract(tab.id);
    await page.screenshot({path:resolve(out, site.name + '-initial.png')});
    assert.equal(initial.scrollY, 0, site.name + ': starts without scrolling');
    let report = {name:site.name,url:site.url,title:await page.title(),baselineAvailable,initial:{...initial,textBeforeLength:baselineAvailable?initialExtract.before.text.length:null,textAfterLength:initialExtract.after.text.length,sameText:baselineAvailable?initialExtract.before.text===initialExtract.after.text:null}};
    if (site.open) {
      assert.equal(initial.comments.length,0,site.name + ': comments not loaded before opening');
      report.commentCountLabel = await page.locator(site.open).innerText();
      await page.locator(site.open).click();
      await page.locator(site.comments).first().waitFor({state:'attached'});
      // note scrolls after its async comment load; wait for that transition to settle.
      await page.evaluate(() => new Promise((resolve,reject) => {
        let y = scrollY, stableSince = performance.now(); const started = stableSince;
        const check = () => {
          const now = performance.now();
          if(scrollY!==y) {y=scrollY;stableSince=now;}
          if(now-stableSince>=700) resolve();
          else if(now-started>5000) reject(Error('Comment navigation did not settle'));
          else requestAnimationFrame(check);
        }; check();
      }));
      // Return to the top: loaded comments must survive extraction while offscreen.
      await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}));
      await page.waitForFunction(() => scrollY === 0);
    }
    const loaded = await observe(page, site.comments);
    const comparison = await extract(tab.id);
    const commentChecks = loaded.comments.map(c => ({
      ...c, beforeIncluded:baselineAvailable?comparison.before.text.replace(/\s/g,'').includes(c.text.replace(/\s/g,'')):null, afterIncluded:comparison.after.text.replace(/\s/g,'').includes(c.text.replace(/\s/g,''))
    }));
    await writeFile(resolve(out,site.name+'-debug.json'),JSON.stringify({loaded,comparison,commentChecks},null,2));
    if (site.comments) {
      assert.ok(commentChecks.length>0,site.name + ': actual comments available');
      if (site.expectComments) assert.equal(commentChecks.length,site.expectComments);
      assert.ok(commentChecks.every(c=>c.top>loaded.viewport),site.name+': comments below viewport');
      assert.ok(commentChecks.every(c=>(!baselineAvailable||c.beforeIncluded)&&c.afterIncluded),site.name+': all loaded comments retained');
    }
    if(baselineAvailable) assert.equal(comparison.after.text,comparison.before.text,site.name+': natural page text unchanged');
    const capture = await panel.evaluate(async tabId => {
      const { collectImages, captureImages } = await import('./images.js');
      const { readIdentity } = await import('./page-access.js');
      const tab = await chrome.tabs.get(tabId), identity = await readIdentity(chrome,tab);
      const raw = (await chrome.scripting.executeScript({target:{tabId},func:collectImages}))[0].result;
      let screenshotCalls = 0;
      const api = {permissions:chrome.permissions,scripting:chrome.scripting,tabs:{query:async()=>[tab],captureVisibleTab:()=>{screenshotCalls++;throw Error('Expected original image capture without viewport screenshots')}}};
      const result = await captureImages(api,tab,identity);
      const dimensions = await Promise.all(result.images.map(async item=>{const i = new Image();i.src=item.dataUrl;await i.decode();return [i.width,i.height];}));
      return {urls:raw.items.map(item=>item.url),candidates:raw.candidates,viewport:raw.viewport,count:result.images.length,positions:result.images.map(i=>i.position),dimensions,missingOrigins:result.missingOrigins,omitted:result.omitted,screenshotCalls};
    },tab.id);
    assert.ok(capture.count>0,site.name+': images captured');
    assert.deepEqual(capture.missingOrigins,[],site.name+': original image origins permitted');
    capture.positionedCount = capture.positions.filter(Number.isInteger).length;
    capture.unpositionedCount = capture.positions.length - capture.positionedCount;
    // The extension intentionally omits a position when a live page changes a
    // captured image's DOM path while pixels are fetched. Images remain usable.
    assert.ok(capture.positions.every(p=>p===undefined||Number.isInteger(p)),site.name+': image positions valid when known');
    const offscreenCandidates = loaded.images.filter(i=>i.top>loaded.viewport&&capture.urls.includes(i.src));
    if(site.name==='zenn'||site.name==='note-images'||site.name==='note-old') assert.ok(offscreenCandidates.length>0,site.name+': offscreen image retained');
    report = {...report,loaded:{...loaded,comments:commentChecks},comparison:{sameText:baselineAvailable?comparison.before.text===comparison.after.text:null,beforeLength:baselineAvailable?comparison.before.text.length:null,afterLength:comparison.after.text.length},capture,offscreenImageCount:offscreenCandidates.length};
    await writeFile(resolve(out,site.name+'-result.json'),JSON.stringify(report,null,2));
    if(baselineAvailable) await writeFile(resolve(out,site.name+'-text-before.txt'),comparison.before.text);
    await writeFile(resolve(out,site.name+'-text-after.txt'),comparison.after.text);
    if(site.comments) { await page.locator(site.comments).first().scrollIntoViewIfNeeded(); await page.screenshot({path:resolve(out,site.name+'-comments.png')}); }
    reports.push(report);
    console.log(JSON.stringify({name:site.name,comments:commentChecks.length,sameText:report.comparison.sameText,images:capture.count,offscreenImageCount:offscreenCandidates.length,unpositionedCount:capture.unpositionedCount}));
    await page.close();
  }
  await writeFile(resolve(out,'summary.json'),JSON.stringify({checkedAt:new Date().toISOString(),mode:'anonymous isolated MV3 browser; natural DOM only',reports},null,2));
} finally {await context.close()}
