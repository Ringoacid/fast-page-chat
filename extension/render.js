// A DOM-only Markdown subset. Raw HTML is always displayed as text.
function inline(parent, text) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g; let offset = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(offset, match.index)));
    const value = match[0]; let node;
    if (value.startsWith('`')) { node = document.createElement('code'); node.textContent = value.slice(1, -1); }
    else if (value.startsWith('**')) { node = document.createElement('strong'); node.textContent = value.slice(2, -2); }
    else { const split = value.indexOf(']('); node = document.createElement('a'); node.textContent = value.slice(1, split); node.href = value.slice(split + 2, -1); node.target = '_blank'; node.rel = 'noopener noreferrer'; }
    parent.append(node); offset = match.index + value.length;
  }
  parent.append(document.createTextNode(text.slice(offset)));
}
export function renderMarkdown(target, text) {
  const fragment = document.createDocumentFragment(), lines = text.split('\n'); let paragraph = [], list = null;
  const flush = () => { if (paragraph.length) { const p = document.createElement('p'); inline(p, paragraph.join('\n')); fragment.append(p); paragraph = []; } list = null; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { flush(); const block = []; while (++i < lines.length && !/^\s*```/.test(lines[i])) block.push(lines[i]); const pre = document.createElement('pre'), code = document.createElement('code'); code.textContent = block.join('\n'); pre.append(code); fragment.append(pre); continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) { flush(); const h = document.createElement(`h${Math.min(heading[1].length + 1, 5)}`); inline(h, heading[2]); fragment.append(h); continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { flush(); fragment.append(document.createElement('hr')); continue; }
    const item = /^\s*(?:([-*+])|\d+[.)])\s+(.+)$/.exec(line);
    if (item) { if (paragraph.length) flush(); const kind = item[1] ? 'UL' : 'OL'; if (list?.tagName !== kind) { list = document.createElement(kind); fragment.append(list); } const li = document.createElement('li'); inline(li, item[2]); list.append(li); continue; }
    if (line.startsWith('> ')) { flush(); const quote = document.createElement('blockquote'); inline(quote, line.slice(2)); fragment.append(quote); continue; }
    if (!line.trim()) { flush(); continue; } list = null; paragraph.push(line);
  }
  flush(); target.replaceChildren(fragment);
}
export const paths = {
  image: 'M3 3h18v18H3zM3 16l5-5 4 4 3-3 6 6M15 7h.01',
  history: 'M4 5h16M4 12h12M4 19h16', plus: 'M12 5v14M5 12h14', settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  close: 'm6 6 12 12M6 18 18 6', chevron: 'm8 10 4 4 4-4', send: 'M12 19V5m-6 6 6-6 6 6', stop: 'M7 7h10v10H7z',
  skills: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z', copy: 'M9 9h11v11H9zM15 9V4H4v11h5',
  more: 'M5 12h.01M12 12h.01M19 12h.01', page: 'M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6',
  trash: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7', edit: 'm15 4 5 5-11 11H4v-5zM12 7l5 5',
  pin: 'm8 3 8 0-1 6 4 4v2H5v-2l4-4zM12 15v7', search: 'M15 15l6 6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', check: 'm5 12 4 4L19 6'
};
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[name] || paths.page); svg.append(path); return svg;
}
export function iconButton(name, label, callback) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-button'; button.setAttribute('aria-label', label); button.title = label; button.append(icon(name));
  if (callback) button.addEventListener('click', callback); return button;
}
