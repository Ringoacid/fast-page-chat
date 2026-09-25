import { checkTab, pageAccessError, readIdentity, sameDocument } from './page-access.js';
import { extractPage } from './extract.js';

export const DEFAULT_IMAGE_COUNT = 6;
export const MAX_IMAGE_COUNT = 600;
export const IMAGE_DATA_BUDGET = 60_000_000;
const MAX_IMAGE_CHARS = 650_000;
const FETCH_DEADLINE_MS = 180_000;

// Keep a large selection within the request budget by scaling each image.
function jpegDataUrl(width, height, charLimit, draw) {
  const longest = Math.max(width, height);
  let edge = Math.min(longest, Math.max(320, Math.round(1600 * Math.sqrt(charLimit / MAX_IMAGE_CHARS))));
  for (let attempt = 0; attempt < 5; attempt++) {
    const ratio = Math.min(1, edge / longest);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
    const ctx = canvas.getContext('2d'); draw(ctx, canvas.width, canvas.height);
    let dataUrl = canvas.toDataURL('image/jpeg', .82);
    if (dataUrl.length > charLimit) dataUrl = canvas.toDataURL('image/jpeg', .55);
    if (dataUrl.length <= charLimit) return dataUrl;
    edge = Math.max(160, Math.floor(edge * .72));
  }
  return '';
}

// Runs in the page's isolated world. Collects URLs without scrolling or changing the page.
export function collectImages(scope = 'page', candidateLimit = 24, charLimit = 650000) {
  candidateLimit = Math.max(1, Math.min(600, candidateLimit));
  charLimit = Math.max(1000, Math.min(650000, charLimit));
  // A page may use multi-megabyte data: URLs. Keep their identity without
  // copying the original string into every result and target descriptor.
  const compact = value => {
    if (value == null || value.length <= 2048) return value;
    let hash = 2166136261;
    const stride = Math.max(1, Math.floor(value.length / 2048));
    for (let i = 0; i < value.length; i += stride) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return { length: value.length, hash: hash >>> 0, end: value.slice(-32) };
  };
  const encode = node => {
    const longest = Math.max(node.naturalWidth, node.naturalHeight);
    let edge = Math.min(longest, Math.max(320, Math.round(1600 * Math.sqrt(charLimit / 650000))));
    for (let attempt = 0; attempt < 5; attempt++) {
      const ratio = Math.min(1, edge / longest);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(node.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(node.naturalHeight * ratio));
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(node, 0, 0, canvas.width, canvas.height);
      let dataUrl = canvas.toDataURL('image/jpeg', .82);
      if (dataUrl.length > charLimit) dataUrl = canvas.toDataURL('image/jpeg', .55);
      if (dataUrl.length <= charLimit) return dataUrl;
      edge = Math.max(160, Math.floor(edge * .72));
    }
    return '';
  };
  // aria-hidden only affects the accessibility tree. Amazon search results, for
  // example, use it on product links whose images are still visibly rendered.
  const excluded = 'nav,footer,aside,button,input,textarea,select,[hidden],[role="dialog"]';
  const visible = node => { const style = getComputedStyle(node); return style.display !== 'none' && style.visibility === 'visible'; };
  // Match the text extractor's ancestor/editing checks without excluding
  // offscreen images or visibly rendered aria-hidden product images.
  const readableRoot = (el, mainRegion = false) => {
    for (let node = el; node; node = node.assignedSlot || node.parentElement || node.getRootNode().host) {
      if (node.isContentEditable || node.matches(excluded) || !visible(node) || Number(getComputedStyle(node).opacity) === 0) return false;
      // Choose the same main region as text; aria-hidden descendants of that
      // region can still contain visibly rendered images (for example Amazon).
      if (mainRegion && node.matches('[aria-hidden="true"],[role="navigation"]')) return false;
    }
    return true;
  };
  const roots = [...document.querySelectorAll('main,[role="main"]')].filter(el => readableRoot(el, true));
  let root = roots.sort((a, b) => b.innerText.length - a.innerText.length)[0] || document.body;
  // An explicit article body excludes topic icons, author cards and promotions.
  // Zenn's stable markdown marker is .znc; hashed presentation classes are not used.
  // Keep explicit selections and discussion sites without a body marker unchanged.
  if (scope === 'page') {
    const bodies = [...root.querySelectorAll('[itemprop~="articleBody"],article .znc')].filter(el => readableRoot(el));
    root = bodies.sort((a, b) => b.innerText.length - a.innerText.length)[0] || root;
  }
  const items = [], seen = new Map(), candidates = new Set();
  const selection = window.getSelection();
  const locate = node => {
    const path = [];
    while (node !== document) {
      if (node.parentNode) { path.unshift([...node.parentNode.childNodes].indexOf(node)); node = node.parentNode; }
      else { path.unshift('shadow'); node = node.host; }
    }
    return path;
  };
  const visit = node => {
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const style = getComputedStyle(node);
      if (node.isContentEditable || node.matches(excluded) || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return;
      if (node.tagName === 'IMG') {
        if (node.closest('details:not([open])') && !node.closest('summary')) return;
        if (scope === 'selection' && (!selection?.rangeCount || !selection.getRangeAt(0).intersectsNode(node))) return;
        const rect = node.getBoundingClientRect();
        const lazy = node.getAttribute('data-src') || node.getAttribute('data-original') || node.getAttribute('data-lazy-src');
        let url;
        try { url = new URL(lazy || node.currentSrc || node.getAttribute('src'), document.baseURI).href; } catch { return; }
        if (!/^(https?:|data:image\/|blob:)/i.test(url) || (!lazy && !node.currentSrc && !node.getAttribute('src'))) return;
        // Lazy loading does not make a rendered 26px topic icon a content image.
        // Only unknown geometry may bypass the size filter before decoding.
        const declaredWidth = Number(node.getAttribute('width')), declaredHeight = Number(node.getAttribute('height'));
        // A missing src can render only alt text, ignoring the declared dimensions.
        // Reddit comment images can report a 20px placeholder before loading
        // while declaring width="240" and height="auto". One large declared
        // dimension is enough; an explicitly small other dimension still fails.
        const pendingLayout = !node.naturalWidth && (lazy || node.loading === 'lazy') && (rect.width === 0 || rect.height === 0 || declaredWidth >= 60 || declaredHeight >= 40);
        const explicitlySmall = (node.hasAttribute('width') && Number(node.getAttribute('width')) > 0 && Number(node.getAttribute('width')) < 60) || (node.hasAttribute('height') && Number(node.getAttribute('height')) > 0 && Number(node.getAttribute('height')) < 40);
        if ((rect.width < 60 || rect.height < 40) && (!pendingLayout || explicitlySmall)) return;
        if (!lazy && node.complete && node.naturalWidth && (node.naturalWidth < 80 || node.naturalHeight < 60)) return;
        candidates.add(url);
        if (items.length >= candidateLimit && !seen.has(url)) return;
        const label = (node.alt || 'ページ内の画像').slice(0, 280);
        const target = { path: locate(node), source: compact(node.currentSrc), attributes: ['src', 'srcset', 'data-src', 'data-original', 'data-lazy-src'].map(name => compact(node.getAttribute(name))) };
        const item = { url: /^https?:/i.test(url) ? url : '', label, target, blurred: style.filter.includes('blur(') };
        try {
          if (!node.complete || !node.naturalWidth || (lazy && url !== node.currentSrc)) throw new Error('Image needs loading');
          const dataUrl = encode(node);
          if (dataUrl) item.dataUrl = dataUrl;
        } catch { /* The extension can fetch the original after host access is granted. */ }
        const x = Math.max(0, rect.left), y = Math.max(0, rect.top);
        const width = Math.min(innerWidth, rect.right) - x, height = Math.min(innerHeight, rect.bottom) - y;
        // Do not capture a modal or another element covering the image center.
        const surface = node.getRootNode();
        const hit = width >= 60 && height >= 40 && surface.elementFromPoint?.(x + width / 2, y + height / 2);
        if (!item.dataUrl && node.complete && node.naturalWidth && hit === node) item.rect = { x, y, width, height };
        const previous = seen.get(url);
        // Prefer a foreground copy over Reddit's blurred duplicate, even offscreen.
        if (previous === undefined) { seen.set(url, items.length); items.push(item); }
        else if ((items[previous].blurred && !item.blurred) || (!items[previous].rect && item.rect && !item.blurred)) items[previous] = item;
        return;
      }
    }
    if (node.shadowRoot) visit(node.shadowRoot);
    else if (node.nodeName === 'SLOT') {
      const assigned = node.assignedNodes({ flatten: true });
      for (const child of assigned.length ? assigned : node.childNodes) visit(child);
    } else for (const child of node.childNodes) visit(child);
  };
  if (readableRoot(root)) visit(root);
  return { items, candidates: candidates.size, viewport: { width: innerWidth, height: innerHeight, x: scrollX, y: scrollY }, url: location.href };
}

// Check only screenshot crop targets; re-encoding every page image can duplicate
// tens of megabytes when the user selects a large image limit.
export function verifyImageSnapshot(viewport, targets) {
  const compact = value => {
    if (value == null || value.length <= 2048) return value;
    let hash = 2166136261;
    const stride = Math.max(1, Math.floor(value.length / 2048));
    for (let i = 0; i < value.length; i += stride) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return { length: value.length, hash: hash >>> 0, end: value.slice(-32) };
  };
  const same = (a, b) => a && typeof a === 'object' ? b && a.length === b.length && a.hash === b.hash && a.end === b.end : a === b;
  if (viewport.width !== innerWidth || viewport.height !== innerHeight || viewport.x !== scrollX || viewport.y !== scrollY) return false;
  for (const item of targets) {
    let node = document;
    for (const step of item.target.path) node = step === 'shadow' ? node?.shadowRoot : node?.childNodes[step];
    if (node?.tagName !== 'IMG' || (item.target.source && !same(item.target.source, compact(node.currentSrc)))) return false;
    if (!item.target.attributes.every((value, index) => same(value, compact(node.getAttribute(['src', 'srcset', 'data-src', 'data-original', 'data-lazy-src'][index]))))) return false;
    const bounds = node.getBoundingClientRect();
    const x = Math.max(0, bounds.left), y = Math.max(0, bounds.top);
    const width = Math.min(innerWidth, bounds.right) - x, height = Math.min(innerHeight, bounds.bottom) - y;
    if (item.rect.x !== x || item.rect.y !== y || item.rect.width !== width || item.rect.height !== height) return false;
    const style = getComputedStyle(node), hit = node.getRootNode().elementFromPoint?.(x + width / 2, y + height / 2);
    if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || hit !== node) return false;
  }
  return true;
}

// Runs only in the extension, never in a content script or the local bridge.
// Do not forward cookies, the bridge bearer token, or arbitrary response content.
export async function fetchImage(url, api, charLimit = MAX_IMAGE_CHARS, permissionCache = new Map(), timeoutMs = 10000) {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return {};
  const origin = parsed.origin + '/*';
  if (!api.permissions) return { missingOrigin: origin };
  if (!permissionCache.has(origin)) permissionCache.set(origin, api.permissions.contains({ origins: [origin] }));
  if (!await permissionCache.get(origin)) return { missingOrigin: origin };
  let reader;
  try {
    const response = await fetch(parsed.href, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(timeoutMs) });
    reader = response.body?.getReader();
    if (!response.ok || !/^image\//i.test(response.headers.get('content-type') || '')) return {};
    if (Number(response.headers.get('content-length')) > 12_000_000) return {};
    if (!reader) return {};
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 12_000_000) return {};
      chunks.push(value);
    }
    const blob = new Blob(chunks, { type: response.headers.get('content-type') });
    const objectUrl = URL.createObjectURL(blob), image = new Image();
    try {
      image.src = objectUrl; await image.decode();
      if (image.naturalWidth < 80 || image.naturalHeight < 60 || image.naturalWidth * image.naturalHeight > 40_000_000) return {};
      const dataUrl = jpegDataUrl(image.naturalWidth, image.naturalHeight, charLimit, (ctx, width, height) => {
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); ctx.drawImage(image, 0, 0, width, height);
      });
      return dataUrl ? { dataUrl } : {};
    } finally { image.src = ''; URL.revokeObjectURL(objectUrl); }
  } catch { return {}; }
  finally { await reader?.cancel().catch(() => {}); }
}

export async function captureImages(api, tab, identity, scope = 'page', savedPage = null, maxImages = DEFAULT_IMAGE_COUNT, onProgress = () => {}) {
  if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > MAX_IMAGE_COUNT) throw new Error('画像の最大枚数は1〜600枚で指定してください。');
  checkTab(tab);
  const charLimit = Math.min(MAX_IMAGE_CHARS, Math.floor(IMAGE_DATA_BUDGET / maxImages));
  const candidateLimit = Math.min(MAX_IMAGE_COUNT, Math.max(24, maxImages));
  const check = async () => {
    const active = (await api.tabs.query({ active: true, windowId: tab.windowId }))[0];
    if (active?.id !== tab.id || !sameDocument(identity, await readIdentity(api, tab))) throw new Error('ページが変わりました。新しいチャットで画像を取得してください。');
  };
  try {
    await check();
    const [result] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: collectImages, args: [scope, candidateLimit, charLimit] });
    if (result?.error) throw new Error(result.error.message);
    const snapshot = result?.result;
    if (!snapshot || snapshot.url !== identity.url) throw new Error('画像を取得できませんでした。');
    const missingOrigins = new Set();
    const permissionCache = new Map(), deadline = Date.now() + FETCH_DEADLINE_MS;
    let available = 0, timedOut = false;
    // Bounded batches and a total deadline keep broken hosts from stalling a large capture.
    for (let start = 0; start < snapshot.items.length; start += 8) {
      const batch = snapshot.items.slice(start, start + 8);
      if (batch.some(item => !item.dataUrl)) {
        if (Date.now() >= deadline) { timedOut = true; break; }
        await check();
      }
      await Promise.all(batch.map(async item => {
        if (item.dataUrl || !item.url) return;
        const loaded = await fetchImage(item.url, api, charLimit, permissionCache, Math.max(1, Math.min(10000, deadline - Date.now())));
        if (loaded.dataUrl) item.dataUrl = loaded.dataUrl;
        if (loaded.missingOrigin) missingOrigins.add(loaded.missingOrigin);
      }));
      available += batch.filter(item => item.dataUrl).length;
      onProgress({ processed: Math.min(start + batch.length, snapshot.items.length), candidates: snapshot.items.length, loaded: available });
      if (available >= maxImages) break;
    }
    let bitmap;
    const images = [], targets = []; let total = 0;
    try {
      for (const item of snapshot.items) {
        if (images.length >= maxImages) break;
        let dataUrl = item.dataUrl;
        let label = item.label;
        if (!dataUrl && item.rect) {
          // Failed candidates do not occupy an image slot. Capture only when
          // the adoption loop actually reaches a crop before filling the limit.
          if (!bitmap) {
            // Only image rectangles are retained. The complete screenshot is never stored or sent.
            await check();
            const screenshot = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
            await check();
            const [after] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: verifyImageSnapshot, args: [snapshot.viewport, snapshot.items.filter(item => item.rect && !item.dataUrl).map(item => ({ rect: item.rect, target: item.target }))] });
            if (!after.result) throw new Error('取得中に画像の位置が変わりました。スクロールを止めて再取得してください。');
            const image = new Image(); image.src = screenshot; await image.decode();
            bitmap = await createImageBitmap(image);
          }
          label += '（画面に表示された範囲）';
          const r = item.rect, scaleX = bitmap.width / snapshot.viewport.width, scaleY = bitmap.height / snapshot.viewport.height;
          dataUrl = jpegDataUrl(r.width * scaleX, r.height * scaleY, charLimit, (ctx, width, height) => {
            ctx.drawImage(bitmap, r.x * scaleX, r.y * scaleY, r.width * scaleX, r.height * scaleY, 0, 0, width, height);
          });
        }
        if (!dataUrl || dataUrl.length > charLimit || total + dataUrl.length > IMAGE_DATA_BUDGET) continue;
        total += dataUrl.length; images.push({ dataUrl, label });
        targets.push({ ...item.target, id: images.length });
      }
    } finally { bitmap?.close(); }
    await check();
    if (!images.length && snapshot.candidates > 0 && !missingOrigins.size) throw new Error('取得できる画像がありません。画像の読み込み後に再取得してください。');
    const [extracted] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: extractPage, args: [scope, 60000, targets] });
    if (extracted?.error) throw new Error(extracted.error.message);
    if (!extracted?.result || extracted.result.sourceUrl !== identity.url) throw new Error('本文と画像を対応づけられませんでした。再取得してください。');
    const { sourceUrl, imagePositions, ...page } = extracted.result;
    if (savedPage && page.text !== savedPage.text) throw new Error('保存した本文からページの内容が変わりました。新しいチャットで本文と画像を取得してください。');
    for (const position of imagePositions || []) images[position.id - 1].position = position.offset;
    await check();
    return { images, page, missingOrigins: [...missingOrigins], omitted: Math.max(0, snapshot.candidates - images.length), limit: maxImages, timedOut, capturedAt: new Date().toISOString() };
  } catch (error) { throw pageAccessError(error); }
}
