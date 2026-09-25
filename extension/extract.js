// Serialized into the active tab's isolated world by chrome.scripting.executeScript.
// No network, no persistent content script, no mutation of the source page.
export function extractPage(scope = 'page', maxChars = 60000, imageTargets = []) {
  const started = performance.now();
  const compact = value => {
    if (value == null || value.length <= 2048) return value;
    let hash = 2166136261;
    const stride = Math.max(1, Math.floor(value.length / 2048));
    for (let i = 0; i < value.length; i += stride) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return { length: value.length, hash: hash >>> 0, end: value.slice(-32) };
  };
  const same = (a, b) => a && typeof a === 'object' ? b && a.length === b.length && a.hash === b.hash && a.end === b.end : a === b;
  const excluded = 'script,style,noscript,template,nav,footer,aside,button,input,textarea,select,[hidden],[aria-hidden="true"],[role="navigation"],[role="dialog"]';
  const visible = el => {
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
  };
  // Root selection must obey the same exclusions as walking from the body.
  // Follow slots and shadow hosts, but never filter by viewport coordinates:
  // loaded comments below the fold are still part of the page.
  const readableRoot = el => {
    for (let node = el; node; node = node.assignedSlot || node.parentElement || node.getRootNode().host) {
      if (node.isContentEditable || node.matches(excluded) || !visible(node)) return false;
    }
    return true;
  };
  const normalize = value => value.replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const targets = new Map(), imagePositions = [];
  for (const target of imageTargets) {
    let node = document;
    for (const step of target.path) node = step === 'shadow' ? node?.shadowRoot : node?.childNodes[step];
    // A lazy image or its DOM path can change while its pixels are fetched.
    // Keep the captured image, but do not claim a position for an unverified node.
    if (node?.tagName !== 'IMG' || (target.source && !same(target.source, compact(node.currentSrc))) || (target.attributes && !target.attributes.every((value, index) => same(value, compact(node.getAttribute(['src', 'srcset', 'data-src', 'data-original', 'data-lazy-src'][index])))))) continue;
    targets.set(node, target.id);
  }
  let text = '';
  if (scope === 'selection') {
    text = window.getSelection()?.toString().trim() || '';
    if (!text) throw new Error('ページ上で文章を選択してから再取得してください。');
    const selection = window.getSelection();
    if (selection.rangeCount === 1) {
      const range = selection.getRangeAt(0), raw = selection.toString(), leading = raw.length - raw.trimStart().length;
      for (const [node, id] of targets) {
        // Range offsets cannot reliably locate selections across shadow trees.
        if (node.getRootNode() !== range.startContainer.getRootNode() || node.getRootNode() !== range.endContainer.getRootNode()) continue;
        if (!range.intersectsNode(node)) continue;
        const prefix = range.cloneRange(); prefix.setEndBefore(node);
        imagePositions.push({ id, offset: Math.max(0, Math.min(text.length, prefix.toString().trimEnd().length - leading)) });
      }
    }
  } else {
    const roots = [...document.querySelectorAll('main,[role="main"]')].filter(readableRoot);
    // Prefer the main region over a single article so loaded discussion comments survive.
    const root = roots.sort((a, b) => b.innerText.length - a.innerText.length)[0] || document.body;
    const parts = [], boundaries = []; let rawLength = 0;
    const append = value => { parts.push(value); rawLength += value.length; };
    // Keep aria-hidden text out of the snapshot, but retain the position of a
    // visibly rendered image inside it (for example an Amazon product image).
    const markImageTargets = node => {
      if (targets.has(node)) boundaries.push({ id: targets.get(node), rawOffset: rawLength });
      if (node.shadowRoot) markImageTargets(node.shadowRoot);
      else if (node.nodeName === 'SLOT') {
        const assigned = node.assignedNodes({ flatten: true });
        for (const child of assigned.length ? assigned : node.childNodes) markImageTargets(child);
      } else for (const child of node.childNodes) markImageTargets(child);
    };
    const walk = node => {
      if (node.nodeType === Node.TEXT_NODE) { if (node.textContent.trim()) append(node.textContent); return; }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      if (node.nodeType === Node.ELEMENT_NODE) {
        // isContentEditable also covers the empty/plaintext-only spellings and
        // inherited editing state. Explicit user selections remain unchanged.
        if (node.isContentEditable || !visible(node)) return;
        if (node.matches('[aria-hidden="true"]')) { if (targets.size) markImageTargets(node); return; }
        if (node.matches(excluded)) return;
      }
      const block = node.nodeType === Node.ELEMENT_NODE && /^(block|flex|grid|table|list-item)/.test(getComputedStyle(node).display);
      if (block || node.nodeName === 'BR') append('\n');
      if (targets.has(node)) boundaries.push({ id: targets.get(node), rawOffset: rawLength });
      if (node.shadowRoot) walk(node.shadowRoot);
      else if (node.nodeName === 'SLOT') {
        const assigned = node.assignedNodes({ flatten: true });
        for (const child of assigned.length ? assigned : node.childNodes) walk(child);
      } else for (const child of node.childNodes) walk(child);
      if (block) append('\n');
    };
    const rootReadable = readableRoot(root);
    if (rootReadable) walk(root);
    const raw = parts.join(''); text = normalize(raw);
    for (const boundary of boundaries) imagePositions.push({ id: boundary.id, offset: normalize(raw.slice(0, boundary.rawOffset)).length });
    if (!text && rootReadable && root.querySelector('img')) text = '[画像中心のページ。抽出できる本文はありません。画像が添付されていなければ内容は不明です。]';
    if (!text) throw new Error('本文を取得できません。ページの読み込み後に再取得してください。PDF・ブラウザの内部ページには対応していません。');
  }
  const originalLength = text.length;
  const truncated = originalLength > maxChars;
  if (truncated) {
    text = text.slice(0, maxChars);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  }
  // Drop query strings/fragments, which may contain access tokens or private search parameters.
  const url = new URL(location.href); url.search = ''; url.hash = ''; url.username = ''; url.password = '';
  // sourceUrl is used locally to detect navigation; page-access.js removes it
  // before the snapshot can be sent to the server.
  return { sourceUrl: location.href, title: document.title.slice(0, 2000), url: url.href, text, scope, truncated, originalLength, capturedAt: new Date().toISOString(), extractionMs: Math.round(performance.now() - started), ...(imageTargets.length ? { imagePositions: imagePositions.filter(p => p.offset <= text.length) } : {}) };
}
