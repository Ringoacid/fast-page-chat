import { captureTab, readIdentity, sameDocument } from './page-access.js';
import { readSSE } from './stream.js';
import { openStore, createChat, conversationInput, recoverInterrupted, sortChats, chatMarkdown } from './chat-store.js';
import { renderMarkdown, icon, iconButton } from './render.js';
import { applyTheme } from './theme.js';
import { pageWithImageMarkers } from './page-context.js';
import { captureImages, DEFAULT_IMAGE_COUNT, MAX_IMAGE_COUNT } from './images.js';
import { effortOptions, effortLabel } from './effort.js';
import { titleModelOptions } from './title-models.js';
import { PRIVACY_CONSENT_VERSION, BRIDGE_ENDPOINT, NATIVE_HOST, hasDataConsent, requireDataConsent, assertCompatibleBridge, validateNativeConnection, trustedLoginUrl, resolveTitleConnection } from './setup.js';
import { HELPER_DOWNLOAD_URL } from './release-config.js';

const $ = id => document.getElementById(id);
const endpoint = BRIDGE_ENDPOINT;
const allWebOrigins = ['https://*/*', 'http://*/*'];
let settings = { token: '', provider: 'codex', codexModel: '', apiModel: '', effort: '', includeImages: false, maxImages: DEFAULT_IMAGE_COUNT, theme: 'system', sendKey: 'enter', customModels: { codex: [], api: [] }, aiTitle: true, retitle: true, titleProvider: 'same', titleModel: 'gpt-6-luna' };
let bridgeReady = false, diagnostics = null, setupWorking = false, loginPoll = null;
const dataChanges = new BroadcastChannel('fast-page-chat-data');
let draftImages = null, imageLoading = false, previewShown = 0;
let db, chat = null, skills = [], chats = [], draftPage = null, identity = null, tabId = null;
let generation = 0, busy = false, controller = null, windowId, editingSkill = null, menuChat = null, menuAnchor = null, editingChatId = null;
let modelCatalog = [], modelRequest = null, saveQueue = Promise.resolve(), sessionTimer, toastTimer, undoAction;
const titleJobs = new Map();
const DATA_LOCK = 'fast-page-chat-data';
const sessionKey = () => 'panel:' + windowId;
const activeTab = async () => (await chrome.tabs.query({ active: true, windowId }))[0];
const currentPage = () => chat?.page || draftPage;
const selectedProvider = () => chat?.provider || settings.provider;
const selectedModel = () => chat ? chat.model : settings[settings.provider === 'api' ? 'apiModel' : 'codexModel'];
const selectedEffort = () => (chat ? chat.effort : settings.effort) || '';
const imagesEnabled = () => Boolean(chat ? chat.includeImages : settings.includeImages);
const imageContext = () => chat ? chat.imageContext : draftImages;
const selectedImages = () => imagesEnabled() ? (imageContext()?.images || []).slice(0, settings.maxImages) : [];
const textNode = (tag, text, className) => { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };
const status = (text = '', error = false) => { $('status').textContent = text; $('status').hidden = !text; $('status').classList.toggle('error', error); };
const on = (id, event, action) => $(id).addEventListener(event, e => { Promise.resolve().then(() => action(e)).catch(error => status(error.message, true)); });
async function closePanel() {
  if (chrome.sidePanel.close && Number.isInteger(windowId)) {
    try { await chrome.sidePanel.close({ windowId }); return; }
    catch (error) { console.error(error); }
  }
  window.close();
}
const openDialog = id => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); $(id).showModal(); };
const closeDialogs = () => document.querySelectorAll('dialog[open]').forEach(d => d.close());
function notify(text, undo) {
  clearTimeout(toastTimer); undoAction = undo; $('toast-text').textContent = text; $('undo').hidden = !undo; $('toast').hidden = false;
  // Toasts must also be reachable above native modal dialogs.
  const host = document.querySelector('dialog[open]') || document.body; host.append($('toast'));
  toastTimer = setTimeout(() => { $('toast').hidden = true; undoAction = null; }, undo ? 10000 : 3000);
}
function updateBusy(value) {
  busy = value;
  for (const id of ['new-chat', 'model-open', 'skills-open', 'refresh', 'scope', 'save-settings', 'chat-menu-open', 'effort-open', 'images-toggle', 'images-refresh', 'images-authorize', 'max-images', 'clear-chats', 'clear-logs']) $(id).disabled = value || imageLoading;
  $('stop').hidden = !value; $('send').hidden = value; $('conversation').setAttribute('aria-busy', String(value)); updateSend(); updateTitleNotice();
}
function updateSend() {
  $('send').disabled = busy || imageLoading || !$('question').value.trim() || !db || !hasDataConsent(settings);
  $('question').style.height = 'auto';
  $('question').style.height = Math.min(Math.max($('question').scrollHeight, 70), 220) + 'px';
}
async function saveSettings() { await chrome.storage.local.set({ settings }); }
async function renderPageAccess() {
  const granted = await chrome.permissions.contains({ origins: allWebOrigins });
  const button = $('page-access-toggle');
  button.dataset.granted = String(granted);
  button.textContent = granted ? '全サイトの許可を解除' : '一度だけ許可する';
  $('page-access-status').textContent = granted
    ? '許可済みです。パネルを開いている間、表示中のページ本文を自動取得します。'
    : '未許可です。通常はページごとにツールバーの「F」ボタンでアクセスします。';
}
async function saveSession() { await chrome.storage.session.set({ [sessionKey()]: { chatId: chat?.id || null, draft: $('question').value } }); }
function persist(record) {
  const task = saveQueue.then(async () => { record.revision = await db.saveChat(structuredClone(record)); });
  saveQueue = task.catch(() => {});
  return task;
}
function updateHeader() {
  $('chat-title').textContent = chat?.title || '新しいチャット';
  $('chat-title').title = chat?.title || '';
  $('chat-menu-open').hidden = !chat;
  updateTitleNotice();
  const model = selectedModel(), provider = selectedProvider();
  const label = modelCatalog.find(m => m.model === model)?.displayName || model || '既定';
  $('model-label').textContent = (provider === 'api' ? 'API' : 'Codex') + ' · ' + label;
  $('model-open').title = (provider === 'api' ? 'OpenAI API' : 'Codex App Server') + ' / ' + label;
  $('effort-label').textContent = 'エフォート · ' + effortLabel(selectedEffort());
  $('images-toggle').setAttribute('aria-pressed', String(imagesEnabled()));
  $('images-label').textContent = imageLoading ? '画像 取得中…' : imagesEnabled() ? '画像 ON' : '画像 OFF';
  const imageCount = imageContext()?.images.length || 0;
  $('images-count').textContent = imageCount + '枚' + (imageContext()?.missingOrigins?.length ? ' · 要許可' : '');
  $('images-open').hidden = !imagesEnabled() && !imageCount;
  const page = currentPage();
  $('source-label').textContent = chat ? '保存したページ' : $('scope').value === 'selection' ? '選択した文章' : 'このページ';
  $('source-open').title = page?.title || '参照する本文を確認';
  $('context-warning').hidden = !page?.truncated;
  $('page-title').textContent = page?.title || '本文を取得できません';
  $('page-url').textContent = page?.url || '';
  $('source-text').textContent = page ? pageWithImageMarkers(page, selectedImages()).text : '';
  $('source-controls').hidden = Boolean(chat);
  $('context-meta').textContent = page ? (page.truncated ? page.originalLength.toLocaleString() + '文字のうち先頭' : '') + page.text.length.toLocaleString() + '文字' + (chat ? ' · チャット開始時の本文' : '') : '';
}
async function capture(expectedTabId = null) {
  if (!hasDataConsent(settings) || $('setup-dialog').open) return false;
  if (expectedTabId !== null) {
    // A delayed toolbar message must not cancel a newer page's capture.
    const previous = generation;
    try { if ((await activeTab())?.id !== expectedTabId || generation !== previous || chat || busy || imageLoading) return false; }
    catch { return false; }
  }
  const ticket = ++generation;
  try {
    const tab = await activeTab(); if (ticket !== generation) return false;
    if (expectedTabId !== null && (tab?.id !== expectedTabId || chat || busy || imageLoading)) return false;
    tabId = tab?.id ?? null;
    const result = await captureTab(chrome, tab, $('scope').value);
    const current = await activeTab();
    if (ticket !== generation || current?.id !== tab.id || !sameDocument(result.identity, await readIdentity(chrome, current))) return false;
    if (ticket !== generation) return false;
    draftPage = result.page; draftImages = null; identity = result.identity; updateHeader();
    if (!chat) status();
    if (!chat && imagesEnabled()) await acquireImages().catch(error => status(error.message, true));
    return true;
  } catch (error) {
    if (ticket !== generation) return false;
    draftPage = null; identity = null; updateHeader();
    if (!chat) status(error.message, true);
    return false;
  }
}
function invalidateDraft() { generation++; draftPage = null; draftImages = null; identity = null; if (!chat) updateHeader(); }
async function newChat(keepHistory = false) {
  if (busy || imageLoading) { status('処理が終わってから切り替えてください。'); return; }
  await saveQueue; chat = null; $('question').value = '';
  if (keepHistory === true) $('chat-menu-dialog').close(); else closeDialogs();
  status(); invalidateDraft();
  renderChat(); await saveSession(); await capture(); if (keepHistory !== true) $('question').focus();
}
async function loadChat(id) {
  if (busy || imageLoading) { status('処理が終わってから切り替えてください。'); return; }
  await saveQueue;
  const record = await db.getChat(id);
  if (!record) { notify('このチャットは削除されています。'); await renderHistory(); return; }
  // Only recover an abandoned generation if no panel currently owns its lock.
  await navigator.locks.request('chat:' + id, { ifAvailable: true }, async lock => {
    if (lock && recoverInterrupted(record)) await persist(record);
  });
  chat = record; $('question').value = ''; closeDialogs(); status(); renderChat(); await saveSession();
}
function scrollBottom() { $('scroll-area').scrollTop = $('scroll-area').scrollHeight; }
function renderChat({ scrollToBottom = true } = {}) {
  const scrollArea = $('scroll-area');
  const previousScrollTop = scrollArea.scrollTop;
  $('conversation').setAttribute('aria-busy', String(busy));
  $('conversation').replaceChildren(); $('empty-state').hidden = Boolean(chat?.messages.length);
  for (const message of chat?.messages || []) renderMessage(message);
  updateHeader(); updateSend();
  if (scrollToBottom) scrollBottom();
  else scrollArea.scrollTop = previousScrollTop;
}
function renderMessage(message) {
  const article = document.createElement('article'); article.className = 'message ' + message.role; article.dataset.messageId = message.id;
  if (message.role === 'user') article.append(textNode('div', message.text, 'user-bubble'));
  else {
    const content = document.createElement('div'); content.className = 'answer';
    if (message.status === 'streaming') content.classList.add('streaming');
    renderMarkdown(content, message.text);
    article.append(content);
    if (message.status !== 'complete' && message.status !== 'streaming') article.append(textNode('p', message.status === 'failed' ? '回答を取得できませんでした' : '生成が中断されました', 'incomplete'));
    if (message.status !== 'streaming') {
      const tools = document.createElement('div'); tools.className = 'message-tools';
      const copy = iconButton('copy', '回答をコピー', () => navigator.clipboard.writeText(message.text).then(() => notify('コピーしました')).catch(() => status('コピーできませんでした。文章を選択してコピーしてください。', true)));
      tools.append(copy);
      if (message.status !== 'complete') {
        tools.append(iconButton('refresh', 'もう一度質問する', () => { const i = chat.messages.findIndex(m => m.id === message.id); $('question').value = chat.messages[i - 1]?.text || ''; updateSend(); $('question').focus(); }));
      }
      const meta = textNode('span', (message.model || (message.provider === 'api' ? 'OpenAI API' : 'Codex')) + (message.effort ? ' · ' + effortLabel(message.effort) : '') + (message.imageCount ? ' · 画像' + message.imageCount + '枚' : ''), 'message-meta');
      if (message.timing) meta.title = '回答開始 ' + ((message.timing.firstTextMs || 0) / 1000).toFixed(1) + '秒 / 全体 ' + (message.timing.totalMs / 1000).toFixed(1) + '秒';
      tools.append(meta); article.append(tools);
    }
  }
  $('conversation').append(article); return article.querySelector('.answer');
}
async function ask(hasDataLock = false) {
  if (!hasDataLock) return navigator.locks.request(DATA_LOCK, { mode: 'shared', ifAvailable: true }, lock => {
    if (!lock) { status('履歴を削除しています。完了後にもう一度送信してください。'); return; }
    return ask(true);
  });
  if (busy || imageLoading) return;
  if (!hasDataConsent(settings)) { showSetup(); return; }
  const question = $('question').value.trim(); if (!question) return;
  if (!settings.token || !bridgeReady) { showSetup(); status('接続設定を完了してください。', true); return; }
  if (!db) { status('履歴ストレージを開けません。パネルを開き直してください。', true); return; }
  updateBusy(true); controller = new AbortController(); const run = controller;
  let record, answer, persistError = null;
  try {
    if (!chat) {
      if (!draftPage && !await capture()) return;
      const ticket = generation, tab = await activeTab();
      if (!sameDocument(identity, await readIdentity(chrome, tab)) || tab.id !== tabId || ticket !== generation || !draftPage) {
        await capture(); status('ページが変わりました。もう一度送信してください。'); return;
      }
      if (imagesEnabled() && !draftImages) await acquireImages();
      chat = createChat(draftPage, settings.provider, selectedModel(), question);
      chat.effort = settings.effort; chat.includeImages = settings.includeImages;
      chat.imageContext = draftImages ? structuredClone(draftImages) : null;
      chat.sourceIdentity = identity; chat.sourceTabId = tabId;
      const matchedSkill = skills.find(s => s.prompt === question);
      if (matchedSkill) chat.title = matchedSkill.title + ' · ' + chat.page.title.slice(0, 55);
    }
    record = chat;
    if (imagesEnabled() && !imageContext()) await acquireImages();
    if (imagesEnabled() && !imageContext()?.images.length && imageContext()?.omitted > 0) throw new Error('画像が未取得です。枚数ボタンから画像の取得を許可するか、画像をOFFにしてください。');
    await navigator.locks.request('chat:' + record.id, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('このチャットは別のパネルで生成中です。完了後に再試行してください。');
      run.signal.throwIfAborted();
      const history = conversationInput(record.messages);
      const images = record.includeImages ? (record.imageContext?.images || []).slice(0, settings.maxImages) : [];
      answer = { id: crypto.randomUUID(), role: 'assistant', text: '', status: 'streaming', provider: record.provider, model: record.model, effort: record.effort || '', imageCount: images.length };
      record.messages.push({ id: crypto.randomUUID(), role: 'user', text: question, status: 'complete' }, answer);
      record.updatedAt = Date.now(); await persist(record);
      $('question').value = ''; await saveSession(); renderChat(); status('回答を生成しています…');
      let content = $('conversation').lastElementChild.querySelector('.answer');
      const response = await fetch(endpoint + '/chat', {
        method: 'POST', headers: { Authorization: 'Bearer ' + settings.token, 'Content-Type': 'application/json' }, signal: run.signal,
        body: JSON.stringify({ provider: record.provider, model: record.model, effort: record.effort || '', images, page: record.page, question, history })
      });
      if (!response.ok) {
        if (response.status === 401) throw new Error('接続キーが違います。設定を確認してください。');
        const body = await response.json().catch(() => ({})); throw new Error(body.error || '接続エラー: HTTP ' + response.status);
      }
      // Rewriting a large image snapshot for every streamed token would make
      // high image counts unnecessarily expensive; the final answer is saved below.
      let done = false, checkpoint = performance.now();
      const checkpointInterval = images.reduce((size, image) => size + image.dataUrl.length, 0) > 4_000_000 ? 15000 : 1500;
      for await (const event of readSSE(response.body)) {
        if (event.type === 'delta') {
          answer.text += event.text; renderMarkdown(content, answer.text);
          if (performance.now() - checkpoint > checkpointInterval && !persistError) {
            checkpoint = performance.now(); persist(record).catch(error => { persistError = error; });
          }
        }
        if (event.type === 'error') throw new Error(event.message);
        if (event.type === 'done') { done = true; answer.timing = { firstTextMs: event.firstTextMs, totalMs: event.totalMs }; }
      }
      if (!done || !answer.text) throw new Error('回答が完了しませんでした。もう一度お試しください。');
      answer.status = 'complete'; status();
    });
  } catch (error) {
    if (answer) answer.status = run.signal.aborted ? 'interrupted' : 'failed';
    status(run.signal.aborted ? '生成を停止しました。' : error instanceof TypeError ? '接続できません。ローカルサーバーの起動を確認してください。' : error.message, !run.signal.aborted);
    if (!answer) $('question').value = question;
    } finally {
    if (answer) {
      if (answer.status === 'streaming') answer.status = 'interrupted';
      record.updatedAt = Date.now();
      try { await persist(record); } catch (error) { persistError = error; }
      if (persistError) status('履歴を保存できませんでした。' + persistError.message, true);
      renderChat({ scrollToBottom: false });
    }
    controller = null; updateBusy(false);
    await saveSession().catch(error => status(error.message, true));
    if (answer?.status === 'complete' && !persistError) updateTitle(record).catch(error => {
      if (chat?.id === record.id && !busy) status('タイトル生成: ' + error.message, true);
    });
  }
}

function updateTitleNotice() {
  const failure = !chat?.titleEdited && chat?.titleFailure;
  const pending = titleJobs.has(chat?.id);
  const notice = $('title-notice'), retry = $('title-retry');
  if (!failure && !notice.hidden && document.activeElement === retry) $('question').focus();
  notice.hidden = !failure;
  $('title-error').textContent = failure || '';
  retry.disabled = busy || pending;
  retry.textContent = pending ? '再生成中…' : 'タイトルを再生成する';
  retry.setAttribute('aria-busy', String(pending));
}

async function updateTitle(record, { retry = false } = {}) {
  requireDataConsent(settings);
  const answerCount = record.messages.filter(m => m.role === 'assistant' && m.status === 'complete').length;
  const autoEnabled = () => answerCount === 1 ? settings.aiTitle : settings.retitle;
  if (!answerCount || record.titleEdited || (!retry && !autoEnabled())) return;
  const previous = titleJobs.get(record.id);
  if (previous && retry) return;
  // A completed newer answer supersedes any title request using older messages.
  previous?.controller.abort();
  const job = { controller: new AbortController() };
  titleJobs.set(record.id, job); updateTitleNotice();
  const originalTitle = record.title, messageCount = record.messages.length;
  const applicable = latest => latest?.id === record.id && titleJobs.get(record.id) === job && !job.controller.signal.aborted &&
    !latest.titleEdited && editingChatId !== record.id && latest.title === originalTitle && latest.messages.length === messageCount &&
    (retry || autoEnabled());
  const messages = [...record.messages.slice(0, 2), ...record.messages.slice(-10)]
    .filter((m, index, all) => all.findIndex(other => other.id === m.id) === index && m.status === 'complete')
    .map(m => ({ role: m.role, text: m.text.slice(0, 4000) }));
  let title, failure;
  try {
    try {
      const response = await fetch(endpoint + '/title', {
        method: 'POST', headers: { Authorization: 'Bearer ' + settings.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...resolveTitleConnection(settings, record), pageTitle: record.page.title, currentTitle: originalTitle, messages }),
        signal: AbortSignal.any([job.controller.signal, AbortSignal.timeout(65000)])
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'タイトルを生成できませんでした。');
      if (typeof result.title !== 'string' || !result.title.trim()) throw new Error('タイトルを生成できませんでした。');
      title = result.title;
    } catch (error) {
      if (job.controller.signal.aborted) return;
      failure = error.name === 'TimeoutError' ? 'タイトル生成が時間内に完了しませんでした。' :
        error instanceof TypeError ? '接続できません。ローカルサーバーの起動を確認してください。' :
        String(error.message || 'タイトルを生成できませんでした。').slice(0, 400);
    }
    // Only hold the conversation lock while saving metadata, never during the request.
    await navigator.locks.request('chat:' + record.id, async () => {
      const task = saveQueue.then(async () => {
        const latest = await db.getChat(record.id);
        if (!applicable(latest)) return;
        if (title) latest.title = title;
        latest.titleFailure = failure || null;
        const revision = await db.saveChat(latest);
        for (const target of new Set([record, chat])) {
          if (target?.id === latest.id && target.revision === latest.revision) {
            // A rename may already be queued while the IndexedDB write is pending.
            // Advance its revision, but preserve the user's unsaved title fields.
            if (!target.titleEdited && target.title === originalTitle && target.messages.length === messageCount) {
              target.title = latest.title; target.titleFailure = latest.titleFailure;
            }
            target.revision = revision;
          }
        }
        if (chat?.id === latest.id) updateHeader();
      });
      saveQueue = task.catch(() => {});
      await task;
    });
    if ($('history-dialog').open && !editingChatId) await renderHistory();
  } catch (error) {
    // Keep recovery available in this panel even if storage itself is unavailable.
    if (applicable(chat)) {
      chat.titleFailure = failure || '生成したタイトルを保存できませんでした。';
      status(error.message, true);
    }
  } finally {
    if (titleJobs.get(record.id) === job) titleJobs.delete(record.id);
    updateTitleNotice();
  }
}

async function acquireImages() {
  requireDataConsent(settings);
  if (imageLoading) throw new Error('画像の取得が終わるまでお待ちください。');
  const target = chat, expected = target ? target.sourceIdentity : identity, ticket = generation;
  if (!expected) throw new Error('この履歴には画像がありません。新しいチャットで画像を取得してください。');
  imageLoading = true; updateBusy(busy); updateHeader();
  try {
    const tab = await activeTab();
    if (tab?.id !== (target ? target.sourceTabId : tabId)) throw new Error('参照したページのタブを開いてから画像を取得してください。');
    const { page, ...result } = await captureImages(chrome, tab, expected, (target?.page || draftPage)?.scope, target?.page, settings.maxImages, ({ processed, candidates, loaded }) => {
      const message = `画像を取得中…${processed}/${candidates}件を確認し、${loaded}枚取得しました。`;
      if ($('images-dialog').open) $('image-status').textContent = message;
      else status(message);
    });
    if (target !== chat || (!target && ticket !== generation)) throw new Error('ページが変わりました。画像を再取得してください。');
    if (target) { target.imageContext = result; await persist(target); }
    else { draftImages = result; draftPage = page; }
    status(result.timedOut ? '画像の取得を3分で終了しました。取得済みの画像は利用できます。' : result.missingOrigins.length ? '画面外を含む元画像を取得するには、枚数ボタンから配信元へのアクセスを許可してください。' : ''); renderImages();
  } finally { imageLoading = false; updateBusy(busy); updateHeader(); }
}
function appendImagePreview() {
  const images = imageContext()?.images || [], end = Math.min(images.length, previewShown + 40);
  for (let i = previewShown; i < end; i++) {
    const item = images[i];
    const figure = document.createElement('figure'), img = document.createElement('img');
    img.src = item.dataUrl; img.alt = item.label; img.decoding = 'async'; img.loading = 'lazy';
    figure.append(img, textNode('figcaption', `画像${i + 1} · ${item.label}${Number.isInteger(item.position) ? '' : '（本文中の位置は不明）'}`)); $('image-preview').append(figure);
  }
  previewShown = end;
  $('images-more').hidden = end >= images.length;
  $('images-more').textContent = `さらに表示（${end}/${images.length}枚を表示中）`;
}
function renderImages() {
  const context = imageContext(); $('image-preview').replaceChildren(); previewShown = 0;
  if ($('images-dialog').open) appendImagePreview();
  const origins = context?.missingOrigins || [];
  $('images-authorize').hidden = !origins.length;
  $('image-permissions').hidden = !origins.length;
  $('image-permissions').textContent = origins.length ? '元画像の取得に必要な配信元：' + origins.map(origin => new URL(origin).hostname).join('、') : '';
  const savedCount = context?.images.length || 0;
  const sendCount = Math.min(savedCount, settings.maxImages);
  $('image-status').textContent = (imagesEnabled() ? '画像 ON' : '画像 OFF · 次の送信には含めません') + '。' + (context ? `${savedCount}枚を保存済み。${imagesEnabled() && sendCount < savedCount ? `次の送信には先頭${sendCount}枚を使用します。` : ''}${context.omitted ? `候補画像のうち${context.omitted}枚は上限または取得条件により省略しました。` : ''}${context.timedOut ? '取得は3分で終了しました。' : ''}` : '画像は未取得です。') + ` 画面外を含む本文中の画像を最大${settings.maxImages}枚取得します。`;
}
async function toggleImages() {
  if (busy || imageLoading) return;
  const enabled = !imagesEnabled();
  settings.includeImages = enabled;
  if (chat) { chat.includeImages = enabled; await persist(chat); }
  await saveSettings(); updateHeader(); renderImages();
  if (enabled && !imageContext()) {
    if (!chat && !draftPage) { await capture(); return; }
    await acquireImages();
  } else status();
}
function renderEfforts() {
  $('effort-list').replaceChildren();
  const options = effortOptions(selectedProvider(), selectedModel(), modelCatalog);
  for (const value of ['', ...options]) {
    const button = document.createElement('button'); button.className = 'model-choice' + (value === selectedEffort() ? ' selected' : '');
    button.setAttribute('aria-pressed', String(value === selectedEffort()));
    button.append(textNode('span', effortLabel(value) + (value ? ` (${value})` : '')));
    if (value === selectedEffort()) button.append(icon('check'));
    button.addEventListener('click', async () => {
      if (busy) return;
      try {
        settings.effort = value;
        if (chat) { chat.effort = value; await persist(chat); }
        await saveSettings(); updateHeader(); $('effort-dialog').close(); $('question').focus();
      } catch (error) { $('effort-status').textContent = error.message; }
    });
    $('effort-list').append(button);
  }
  $('effort-status').textContent = selectedProvider() === 'api' ? '対応する値はモデルにより異なります。自動ではモデルの既定値を使います。' : options.length ? 'このモデルが対応するエフォートです。自動では速度を優先します。' : '対応するエフォートを確認するには、モデル一覧を更新してください。';
}

function useSkill(skill) { if (busy) return; closeDialogs(); $('question').value = skill.prompt; updateSend(); $('question').focus(); saveSession().catch(error => status(error.message, true)); }
async function renderSkills() {
  skills = (await db.list('skills')).sort((a, b) => a.createdAt - b.createdAt);
  $('starter-skills').replaceChildren(); $('skill-list').replaceChildren();
  for (const skill of skills) {
    if ($('starter-skills').children.length < 4) {
      const button = document.createElement('button'); button.className = 'starter'; button.append(icon(skill.id === 'translate' ? 'page' : 'skills'), textNode('span', skill.title), textNode('span', '↗', 'trailing'));
      button.addEventListener('click', () => useSkill(skill)); $('starter-skills').append(button);
    }
    const row = document.createElement('div'); row.className = 'skill-row';
    const use = document.createElement('button'); use.className = 'skill-use'; use.append(textNode('strong', skill.title), textNode('small', skill.prompt)); use.addEventListener('click', () => useSkill(skill));
    row.append(use, iconButton('edit', skill.title + 'を編集', () => editSkill(skill)), iconButton('trash', skill.title + 'を削除', () => removeSkill(skill).catch(e => status(e.message, true)))); $('skill-list').append(row);
  }
  if (!skills.length) $('skill-list').append(textNode('p', 'スキルはまだありません', 'list-empty'));
}
function editSkill(skill = null) {
  editingSkill = skill; $('skill-editor-title').textContent = skill ? 'スキルを編集' : 'スキルを作成';
  $('skill-name').value = skill?.title || ''; $('skill-prompt').value = skill?.prompt || ''; $('skill-error').textContent = '';
  openDialog('skill-editor-dialog'); $('skill-name').focus();
}
async function removeSkill(skill) {
  await db.delete('skills', skill.id); await renderSkills();
  notify('スキルを削除しました', async () => { await db.restore('skills', skill); await renderSkills(); });
}
async function renderHistory() {
  chats = await db.list('chats');
  const scrollTop = $('history-list').scrollTop;
  const list = sortChats(chats, $('history-search').value); $('history-list').replaceChildren(); let previousGroup = '';
  for (const record of list) {
    const date = new Date(record.updatedAt), today = new Date();
    const group = record.pinned ? 'ピン留め' : date.toDateString() === today.toDateString() ? '今日' : '以前のチャット';
    if (group !== previousGroup) { $('history-list').append(textNode('h3', group, 'history-group')); previousGroup = group; }
    const row = document.createElement('div'); row.className = 'history-row' + (chat?.id === record.id ? ' active' : ''); row.dataset.chatId = record.id;
    if (editingChatId === record.id) {
      const form = document.createElement('form'); form.className = 'history-rename';
      const input = document.createElement('input'); input.id = 'history-rename-title'; input.value = record.title; input.required = true; input.maxLength = 100; input.setAttribute('aria-label', 'チャットの名前');
      const save = document.createElement('button'); save.type = 'submit'; save.className = 'quiet-button'; save.textContent = '保存';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'quiet-button'; cancel.textContent = 'キャンセル';
      const error = textNode('p', '', 'history-rename-error'); error.setAttribute('role', 'alert'); error.hidden = true;
      cancel.addEventListener('click', () => { editingChatId = null; renderHistory().then(() => focusHistoryAction(record.id)).catch(e => status(e.message, true)); });
      input.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel.click(); } });
      form.addEventListener('submit', async e => {
        e.preventDefault(); const title = input.value.trim(); if (!title) { input.setCustomValidity('名前を入力してください'); input.reportValidity(); return; }
        const target = chat?.id === record.id ? chat : record; const before = target.title, wasEdited = target.titleEdited, titleFailure = target.titleFailure;
        save.disabled = true; cancel.disabled = true; input.disabled = true;
        try {
          target.title = title; target.titleEdited = true; target.titleFailure = null; await persist(target);
          titleJobs.get(record.id)?.controller.abort(); titleJobs.delete(record.id);
          editingChatId = null; updateHeader(); await renderHistory(); focusHistoryAction(record.id);
        }
        catch (failure) { target.title = before; target.titleEdited = wasEdited; target.titleFailure = titleFailure; error.textContent = failure.message; error.hidden = false; save.disabled = false; cancel.disabled = false; input.disabled = false; input.focus(); }
      });
      input.addEventListener('input', () => { input.setCustomValidity(''); error.hidden = true; });
      form.append(input, save, cancel, error); row.append(form);
    } else {
      const button = document.createElement('button'); button.className = 'history-link'; button.append(textNode('strong', record.title), textNode('small', date.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' }) + ' · ' + record.page.title));
      button.addEventListener('click', () => loadChat(record.id).catch(e => status(e.message, true)));
      const pin = iconButton('pin', record.pinned ? 'ピン留めを解除' : 'ピン留め', () => togglePin(record).catch(e => status(e.message, true))); pin.classList.toggle('pinned', record.pinned); pin.setAttribute('aria-pressed', String(record.pinned));
      const more = iconButton('more', record.title + 'の操作'); more.setAttribute('aria-haspopup', 'dialog'); more.setAttribute('aria-expanded', 'false');
      more.addEventListener('click', () => showChatMenu(record, more));
      row.append(button, pin, more);
    }
    $('history-list').append(row);
  }
  if (!list.length) $('history-list').append(textNode('p', $('history-search').value ? '一致するチャットがありません' : 'チャットはまだありません', 'list-empty'));
  $('history-list').scrollTop = scrollTop;
}
function focusHistoryAction(id) {
  const row = Array.from($('history-list').querySelectorAll('.history-row')).find(item => item.dataset.chatId === id);
  (row?.querySelector('.icon-button[title$="の操作"]') || $('history-search')).focus();
}
function positionChatMenu() {
  if (!$('chat-menu-dialog').open || !menuAnchor?.isConnected) return;
  const anchor = (menuAnchor.closest('.history-row') || menuAnchor).getBoundingClientRect(), menu = $('chat-menu-dialog'), rect = menu.getBoundingClientRect();
  const gap = 8, edge = 12;
  const left = Math.max(edge, Math.min(anchor.right - rect.width, innerWidth - rect.width - edge));
  const below = anchor.bottom + gap, above = anchor.top - rect.height - gap;
  const top = below + rect.height <= innerHeight - edge || above < edge ? below : above;
  menu.style.left = `${left}px`; menu.style.top = `${Math.max(edge, Math.min(top, innerHeight - rect.height - edge))}px`;
}
function showChatMenu(record, anchor) {
  if (busy) { status('生成を停止してから操作してください。'); return; }
  menuChat = chat?.id === record.id ? chat : record;
  menuAnchor = anchor;
  menuAnchor.setAttribute('aria-expanded', 'true');
  menuAnchor.closest('.history-row')?.classList.add('menu-target');
  $('pin-label').textContent = menuChat.pinned ? 'ピン留めを解除する' : 'ピン留めする';
  if ($('history-dialog').open) $('chat-menu-dialog').showModal();
  else openDialog('chat-menu-dialog');
  positionChatMenu();
}
async function startHistoryRename() {
  if (!menuChat) return;
  editingChatId = menuChat.id; $('chat-menu-dialog').close();
  if (!$('history-dialog').open) { $('history-search').value = ''; await renderHistory(); openDialog('history-dialog'); }
  else await renderHistory();
  $('history-rename-title')?.focus(); $('history-rename-title')?.select();
}
async function togglePin(record) {
  if (busy) return;
  const target = chat?.id === record.id ? chat : record; const before = target.pinned; target.pinned = !before;
  try { await persist(target); } catch (error) { target.pinned = before; throw error; }
  await renderHistory();
}
async function deleteChat(record) {
  if (busy) return;
  await saveQueue; await db.delete('chats', record.id);
  if (chat?.id === record.id) await newChat(true);
  else $('chat-menu-dialog').close();
  await renderHistory();
  notify('チャットを削除しました', async () => { await db.restore('chats', record); await renderHistory(); });
}

function renderModels() {
  const provider = $('provider').value, model = selectedProvider() === provider ? selectedModel() : settings[provider === 'api' ? 'apiModel' : 'codexModel'];
  const options = new Map([['', { model: '', displayName: '既定のモデル' }]]);
  if (provider === 'codex') for (const m of modelCatalog) options.set(m.model, m);
  for (const value of settings.customModels?.[provider] || []) options.set(value, { model: value, displayName: value });
  if (model && !options.has(model)) options.set(model, { model, displayName: model });
  $('model-list').replaceChildren();
  for (const option of options.values()) {
    const button = document.createElement('button'); button.className = 'model-choice' + (option.model === model ? ' selected' : '');
    button.setAttribute('aria-pressed', String(option.model === model));
    const label = document.createElement('span'); label.append(textNode('span', option.displayName));
    if (option.model && option.displayName !== option.model) label.append(textNode('small', option.model));
    button.append(label); if (option.model === model) button.append(icon('check'));
    button.addEventListener('click', () => chooseModel(provider, option.model).catch(e => status(e.message, true))); $('model-list').append(button);
  }
  $('load-models').hidden = provider !== 'codex';
  $('custom-model-form').hidden = provider !== 'api';
  $('model-status').textContent = provider === 'api' ? '利用するモデルIDを追加できます。APIの利用料金がかかります。' : '';
}
function updateTitleModelOptions(preserveSaved = true) {
  $('title-model-settings').hidden = settings.titleProvider === 'same';
  if (settings.titleProvider === 'same') return;
  const options = titleModelOptions(settings.titleProvider, modelCatalog, settings.customModels, settings.apiModel, preserveSaved ? settings.titleModel : '');
  if (!options.some(option => option.model === settings.titleModel)) settings.titleModel = 'gpt-6-luna';
  $('title-model').replaceChildren(...options.map(({ model, label }) => {
    const option = document.createElement('option'); option.value = model; option.textContent = label === model ? model : `${label} (${model})`;
    return option;
  }));
  $('title-model').value = settings.titleModel;
  $('title-model-refresh').hidden = settings.titleProvider !== 'codex';
}
async function chooseModel(provider, model) {
  if (busy) return;
  settings.provider = provider; settings[provider === 'api' ? 'apiModel' : 'codexModel'] = model;
  settings.effort = '';
  await saveSettings();
  if (chat) { chat.provider = provider; chat.model = model; chat.effort = ''; await persist(chat); }
  updateHeader(); $('model-dialog').close(); updateSend(); $('question').focus();
}
async function loadModels() {
  if (modelRequest || !settings.token || !hasDataConsent(settings)) return false;
  $('load-models').disabled = true; $('model-status').textContent = 'モデルを読み込んでいます…';
  modelRequest = fetch(endpoint + '/models', { headers: { Authorization: 'Bearer ' + settings.token }, signal: AbortSignal.timeout(35000) });
  try {
    const response = await modelRequest; if (!response.ok) throw new Error('モデル一覧を取得できません。接続設定を確認してください。');
    const data = await response.json(); modelCatalog = data.models || [];
    await chrome.storage.local.set({ modelCatalog }); renderModels(); updateTitleModelOptions(); updateHeader(); return true;
  } catch (error) { $('model-status').textContent = error.message; return false; }
  finally { modelRequest = null; $('load-models').disabled = false; }
}

function showSetup() {
  $('setup-consent').hidden = hasDataConsent(settings);
  $('setup-connect-section').hidden = !hasDataConsent(settings);
  $('setup-provider').value = settings.provider;
  $('setup-api-model').value = settings.apiModel || '';
  $('extension-id').textContent = chrome.runtime.id;
  if (HELPER_DOWNLOAD_URL) { $('helper-download').href = HELPER_DOWNLOAD_URL; $('helper-download').hidden = false; }
  renderSetupState(); openDialog('setup-dialog');
}
function renderSetupState() {
  const provider = $('setup-provider').value;
  for (const element of document.querySelectorAll('.setup-install-info')) element.hidden = bridgeReady;
  $('helper-download').hidden = bridgeReady || !HELPER_DOWNLOAD_URL;
  $('setup-connect').textContent = bridgeReady ? '補助アプリを再接続' : '補助アプリに接続する';
  $('setup-connect').className = bridgeReady ? 'quiet-button' : 'primary wide';
  $('setup-account').hidden = !bridgeReady;
  $('setup-codex').hidden = provider !== 'codex'; $('setup-api').hidden = provider !== 'api';
  $('codex-diagnostic').textContent = diagnostics?.codex?.message || '接続状態を確認してください。';
  $('api-diagnostic').textContent = diagnostics?.api?.message || '';
  const ready = provider === 'codex' ? diagnostics?.codex?.state === 'ready' : diagnostics?.api?.state === 'configured' && Boolean(settings.apiModel);
  $('setup-finish').disabled = !bridgeReady || !ready || setupWorking;
  $('codex-login').hidden = diagnostics?.codex?.state === 'ready';
  for (const id of ['setup-connect', 'setup-diagnose', 'codex-login', 'api-save', 'login-check']) $(id).disabled = setupWorking;
}
async function setupRequest(path, body) {
  requireDataConsent(settings);
  const response = await fetch(endpoint + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + settings.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(40000)
  });
  const reply = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 401 ? '接続キーが一致しません。「補助アプリに接続する」で再接続してください。' : reply.error || '接続を確認できませんでした。');
  return reply;
}
function setupError(error) {
  return error instanceof TypeError ? '補助アプリに接続できません。インストールを確認して「補助アプリに接続する」を押してください。' : error.name === 'TimeoutError' ? '接続の確認が時間内に終わりませんでした。もう一度接続してください。' : error.message;
}
async function checkBridge() {
  try {
    const health = assertCompatibleBridge(await setupRequest('/health'));
    bridgeReady = true;
    $('setup-version').textContent = '拡張機能 ' + chrome.runtime.getManifest().version + ' · 補助アプリ ' + health.version;
    if (!settings.apiModel && health.apiModel) { settings.apiModel = health.apiModel; $('setup-api-model').value = health.apiModel; await saveSettings(); }
    $('connection-summary').textContent = '補助アプリ ' + health.version + ' に接続済み';
    return health;
  } catch (error) { bridgeReady = false; diagnostics = null; $('connection-summary').textContent = setupError(error); renderSetupState(); throw error; }
}
async function diagnoseConnection() {
  diagnostics = null;
  await checkBridge();
  diagnostics = assertCompatibleBridge(await setupRequest('/diagnostics'));
  if (diagnostics.codex?.models) { modelCatalog = diagnostics.codex.models; await chrome.storage.local.set({ modelCatalog }); updateTitleModelOptions(); updateHeader(); }
  renderSetupState();
  $('setup-status').textContent = '補助アプリに接続しました。利用する接続先を確認してください。';
}
async function withSetupWork(action) {
  if (setupWorking) return;
  setupWorking = true; renderSetupState(); $('setup-status').textContent = '接続状態を確認しています…';
  try { await action(); }
  catch (error) { $('setup-status').textContent = setupError(error); }
  finally { setupWorking = false; renderSetupState(); }
}
async function connectHelper() {
  requireDataConsent(settings);
  let reply;
  try { reply = validateNativeConnection(await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'connect' })); }
  catch (error) {
    bridgeReady = false;
    if (/native|host|Specified|Access to/i.test(error.message || '')) throw new Error('補助アプリが見つかりません。Windows用補助アプリをインストールして、もう一度接続してください。');
    throw error;
  }
  settings.token = reply.token; settings.nativeConnected = true; $('token').value = reply.token; await saveSettings();
  await diagnoseConnection();
}
async function pollLogin() {
  clearTimeout(loginPoll);
  try {
    const reply = await setupRequest('/login/status');
    if (reply.state === 'ready') {
      $('login-check').hidden = true; await diagnoseConnection(); $('setup-status').textContent = 'ログインできました。読みたいページに戻ってから「ページを読み始める」を押してください。表示中のページを取得します。';
    } else {
      $('setup-status').textContent = reply.message || (reply.state === 'pending' ? 'ブラウザでログインを完了してください。' : 'ログインを完了できませんでした。もう一度お試しください。');
      if (reply.state === 'pending' && $('setup-dialog').open) loginPoll = setTimeout(pollLogin, 2000);
    }
  } catch (error) { $('setup-status').textContent = setupError(error); }
}
function resetDeletedChats() {
  controller?.abort();
  for (const job of titleJobs.values()) job.controller.abort();
  titleJobs.clear(); clearTimeout(toastTimer); undoAction = null; $('toast').hidden = true;
  chat = null; chats = []; menuChat = null; $('question').value = ''; invalidateDraft(); renderChat();
}
dataChanges.onmessage = event => {
  if (event.data === 'chats-cleared') { resetDeletedChats(); status('別のパネルですべてのチャットが削除されました。'); }
};

on('setup-open', 'click', () => { showSetup(); if (hasDataConsent(settings) && settings.token) return withSetupWork(diagnoseConnection); });
on('consent-check', 'change', () => { $('consent-continue').disabled = !$('consent-check').checked; });
on('consent-continue', 'click', async () => {
  if (!$('consent-check').checked) return;
  settings.privacyConsentVersion = PRIVACY_CONSENT_VERSION; await saveSettings(); showSetup(); updateSend();
  if (settings.token) await withSetupWork(diagnoseConnection);
});
on('setup-connect', 'click', () => withSetupWork(connectHelper));
on('setup-diagnose', 'click', () => withSetupWork(diagnoseConnection));
on('setup-provider', 'change', renderSetupState);
on('setup-manual', 'click', () => { openDialog('settings-dialog'); $('manual-connection').open = true; $('token').focus(); });
on('codex-login', 'click', () => withSetupWork(async () => {
  const reply = await setupRequest('/login/start', {});
  const url = trustedLoginUrl(reply.authUrl);
  await chrome.tabs.create({ url }); $('login-check').hidden = false;
  $('setup-status').textContent = 'ブラウザでログインしてください。完了すると接続を確認します。読みたいページに戻ってから開始してください。';
  clearTimeout(loginPoll); loginPoll = setTimeout(pollLogin, 2000);
}));
on('login-check', 'click', pollLogin);
$('setup-dialog').addEventListener('close', () => { clearTimeout(loginPoll); $('setup-api-key').value = ''; });
$('setup-api').addEventListener('submit', event => {
  event.preventDefault();
  withSetupWork(async () => {
    const apiKey = $('setup-api-key').value.trim(), model = $('setup-api-model').value.trim();
    if (!/^[\w.:-]{1,150}$/.test(model)) throw new Error('利用するAPIモデルのIDを入力してください。');
    if (!apiKey && diagnostics?.api?.state !== 'configured') throw new Error('OpenAI APIキーを入力してください。');
    try {
      const reply = await setupRequest('/settings/api', { ...(apiKey ? { apiKey } : {}), model });
      settings.apiModel = reply.apiModel || model;
      settings.customModels ||= { codex: [], api: [] };
      settings.customModels.api = [...new Set([...(settings.customModels.api || []), settings.apiModel])];
      await saveSettings(); await diagnoseConnection();
      $('setup-status').textContent = 'API設定を保存しました。キーとモデルが利用可能かは最初の回答時に確認されます。';
    } finally { $('setup-api-key').value = ''; }
  });
});
on('setup-finish', 'click', async () => {
  if ($('setup-finish').disabled) return;
  settings.provider = $('setup-provider').value; settings.setupCompleted = true; await saveSettings();
  $('setup-dialog').close(); updateHeader(); status(); if (!chat) await capture(); $('question').focus();
});
on('clear-chats', 'click', () => { $('clear-chats-error').textContent = ''; openDialog('clear-chats-dialog'); });
on('clear-chats-confirm', 'click', async () => {
  $('clear-chats-confirm').disabled = true;
  try {
    if (busy || imageLoading) throw new Error('処理が終わってから削除してください。');
    await navigator.locks.request(DATA_LOCK, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw new Error('別のパネルで処理中です。処理を停止してから削除してください。');
      for (const job of titleJobs.values()) job.controller.abort();
      await saveQueue; await db.run('chats', 'readwrite', store => store.clear());
      const sessions = await chrome.storage.session.get(null);
      await chrome.storage.session.remove(Object.keys(sessions).filter(key => key.startsWith('panel:')));
      resetDeletedChats(); dataChanges.postMessage('chats-cleared');
      openDialog('settings-dialog'); $('data-settings-status').textContent = 'すべてのチャット・参照本文・画像を削除しました。';
    });
  } catch (error) { $('clear-chats-error').textContent = error.message; }
  finally { $('clear-chats-confirm').disabled = false; }
});
on('clear-logs', 'click', async () => {
  $('clear-logs').disabled = true; $('data-settings-status').textContent = '診断データを削除しています…';
  try { const result = await setupRequest('/logs/clear', {}); $('data-settings-status').textContent = 'Codexの診断データを削除しました（' + result.count + '件）。'; }
  catch (error) { $('data-settings-status').textContent = setupError(error); }
  finally { $('clear-logs').disabled = false; }
});

for (const element of document.querySelectorAll('[data-icon]')) element.append(icon(element.dataset.icon));
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', e => { if (e.target !== dialog) return; const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); });
  dialog.addEventListener('close', () => { if (dialog.contains($('toast'))) document.body.append($('toast')); });
}
$('history-dialog').addEventListener('close', () => { editingChatId = null; });
$('chat-menu-dialog').addEventListener('close', () => {
  menuAnchor?.setAttribute('aria-expanded', 'false');
  menuAnchor?.closest('.history-row')?.classList.remove('menu-target');
  menuAnchor = null;
});
window.addEventListener('resize', positionChatMenu);
on('new-chat', 'click', newChat);
on('panel-close', 'click', closePanel);
on('images-toggle', 'click', toggleImages);
on('images-open', 'click', () => { openDialog('images-dialog'); renderImages(); });
on('images-more', 'click', appendImagePreview);
on('images-refresh', 'click', async () => { try { await acquireImages(); } catch (error) { $('image-status').textContent = error.message; } });
// Request synchronously inside the click gesture; only the discovered image hosts.
$('images-authorize').addEventListener('click', () => {
  if (busy || imageLoading) return;
  const origins = imageContext()?.missingOrigins || [];
  if (!origins.length) return;
  const target = chat, ticket = generation;
  const permission = chrome.permissions.request({ origins });
  imageLoading = true; updateBusy(busy);
  permission.then(async granted => {
    imageLoading = false; updateBusy(busy);
    if (target !== chat || ticket !== generation) return;
    if (!granted) { $('image-status').textContent = 'アクセスは許可されませんでした。許可済みの画像はそのまま利用できます。'; return; }
    await acquireImages();
  }).catch(error => { imageLoading = false; updateBusy(busy); $('image-status').textContent = error.message; });
});
on('effort-open', 'click', async () => {
  renderEfforts(); openDialog('effort-dialog');
  if (selectedProvider() === 'codex' && !modelCatalog.length) { await loadModels(); renderEfforts(); }
});
on('history-open', 'click', async () => { $('history-search').value = ''; await renderHistory(); openDialog('history-dialog'); });
on('history-search', 'input', renderHistory);
on('settings-open', 'click', async () => {
  if (!hasDataConsent(settings)) { showSetup(); return; }
  $('token').value = settings.token; await renderPageAccess(); openDialog('settings-dialog');
  if (settings.titleProvider === 'codex' && !modelCatalog.length && settings.token) {
    $('title-settings-status').textContent = 'モデル一覧を読み込んでいます…';
    $('title-settings-status').textContent = await loadModels() ? '' : 'モデル一覧を取得できませんでした。更新ボタンで再試行できます。';
  }
});
// The request must be made directly in the click gesture. Chrome keeps the grant
// across pages and sessions until the user removes it here or in browser settings.
$('page-access-toggle').addEventListener('click', () => {
  const button = $('page-access-toggle');
  if (button.disabled) return;
  const removing = button.dataset.granted === 'true';
  button.disabled = true;
  const permission = removing
    ? chrome.permissions.remove({ origins: allWebOrigins })
    : chrome.permissions.request({ origins: allWebOrigins });
  permission.then(async changed => {
    await renderPageAccess();
    if (!changed) { $('page-access-status').textContent = removing ? '全サイトの許可を解除できませんでした。' : 'ブラウザで許可されませんでした。'; return; }
    if (!chat && !busy) { invalidateDraft(); await capture(); }
  }).catch(error => { $('page-access-status').textContent = error.message; })
    .finally(() => { button.disabled = false; });
});
on('source-open', 'click', () => { updateHeader(); openDialog('source-dialog'); });
on('refresh', 'click', () => capture());
on('title-retry', 'click', () => { if (chat && !busy) return updateTitle(chat, { retry: true }); });
on('scope', 'change', () => capture());
on('model-open', 'click', () => { $('provider').value = selectedProvider(); renderModels(); openDialog('model-dialog'); if ($('provider').value === 'codex' && !modelCatalog.length) loadModels(); });
on('provider', 'change', () => { renderModels(); if ($('provider').value === 'codex' && !modelCatalog.length) loadModels(); });
on('load-models', 'click', loadModels);
$('custom-model-form').addEventListener('submit', async e => {
  e.preventDefault(); const model = $('custom-model').value.trim();
  if (!/^[\w.:-]{1,150}$/.test(model)) { $('model-status').textContent = '英数字・ハイフン・アンダースコア・ピリオド・コロンでモデルIDを入力してください。'; return; }
  try {
    settings.customModels ||= { codex: [], api: [] }; settings.customModels.api = [...new Set([...(settings.customModels.api || []), model])];
    await chooseModel('api', model); $('custom-model').value = '';
  } catch (error) { $('model-status').textContent = error.message; }
});
on('skills-open', 'click', async () => { await renderSkills(); openDialog('skills-dialog'); });
on('create-skill-start', 'click', () => editSkill());
on('skill-new', 'click', () => editSkill());
$('skill-form').addEventListener('submit', async e => {
  e.preventDefault();
  const title = $('skill-name').value.trim(), prompt = $('skill-prompt').value.trim();
  if (!title || !prompt) { $('skill-error').textContent = '名前と定型文を入力してください。'; return; }
  try {
    await db.putSkill({ id: editingSkill?.id || crypto.randomUUID(), title, prompt, createdAt: editingSkill?.createdAt || Date.now() });
    await renderSkills(); openDialog('skills-dialog');
  } catch (error) { $('skill-error').textContent = error.message; }
});
on('theme', 'change', async () => { settings.theme = $('theme').value; applyTheme(settings.theme); await saveSettings(); });
on('send-key', 'change', async () => { settings.sendKey = $('send-key').value; await saveSettings(); });
on('ai-title', 'change', async () => { settings.aiTitle = $('ai-title').checked; await saveSettings(); });
on('retitle', 'change', async () => { settings.retitle = $('retitle').checked; await saveSettings(); });
on('title-provider', 'change', async () => {
  settings.titleProvider = $('title-provider').value; updateTitleModelOptions(false); await saveSettings();
  $('title-settings-status').textContent = '';
  if (settings.titleProvider === 'codex' && !modelCatalog.length && settings.token) {
    $('title-settings-status').textContent = 'モデル一覧を読み込んでいます…';
    $('title-settings-status').textContent = await loadModels() ? '' : 'モデル一覧を取得できませんでした。更新ボタンで再試行できます。';
  }
});
on('title-model', 'change', async () => {
  settings.titleModel = $('title-model').value; await saveSettings(); $('title-settings-status').textContent = 'タイトル生成モデルを保存しました。';
});
on('title-model-refresh', 'click', async () => {
  $('title-settings-status').textContent = 'モデル一覧を更新しています…';
  $('title-settings-status').textContent = await loadModels() ? 'モデル一覧を更新しました。' : 'モデル一覧を取得できませんでした。接続設定を確認してください。';
});
on('max-images', 'change', async () => {
  const input = $('max-images'), value = Number(input.value);
  if (!input.value || !Number.isInteger(value) || value < 1 || value > MAX_IMAGE_COUNT) {
    $('max-images-status').textContent = `1〜${MAX_IMAGE_COUNT}の整数を入力してください。`;
    input.value = String(settings.maxImages);
    return;
  }
  const previous = settings.maxImages;
  settings.maxImages = value;
  try { await saveSettings(); }
  catch (error) { settings.maxImages = previous; input.value = String(previous); throw error; }
  $('max-images-status').textContent = `最大${value}枚に設定しました。追加の画像を読むには「画像を再取得」を押してください。`;
  updateHeader(); renderImages();
});
on('save-settings', 'click', async () => {
  requireDataConsent(settings);
  bridgeReady = false;
  settings.token = $('token').value.trim(); settings.nativeConnected = false; await saveSettings(); $('settings-status').textContent = '接続を確認しています…';
  try {
    await diagnoseConnection();
    $('settings-status').textContent = '補助アプリに接続しました。アカウントの状態を確認してください。';
    showSetup();
  } catch (error) { $('settings-status').textContent = setupError(error); }
});
on('chat-menu-open', 'click', () => showChatMenu(chat, $('chat-menu-open')));
on('rename-chat', 'click', startHistoryRename);
on('pin-chat', 'click', async () => { await togglePin(menuChat); $('chat-menu-dialog').close(); });
on('delete-chat', 'click', () => deleteChat(menuChat));
on('export-chat', 'click', () => {
  const url = URL.createObjectURL(new Blob([chatMarkdown(menuChat)], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = menuChat.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 70) + '.md'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000); $('chat-menu-dialog').close();
});
on('undo', 'click', async () => { const action = undoAction; undoAction = null; $('toast').hidden = true; if (action) await action(); });
$('chat-form').addEventListener('submit', e => { e.preventDefault(); ask().catch(error => { updateBusy(false); status(error.message, true); }); });
$('question').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
  const send = settings.sendKey === 'modifier' ? e.ctrlKey || e.metaKey : !e.shiftKey;
  if (send) { e.preventDefault(); $('chat-form').requestSubmit(); }
});
on('question', 'input', () => { updateSend(); clearTimeout(sessionTimer); sessionTimer = setTimeout(() => saveSession().catch(e => status(e.message, true)), 250); });
on('stop', 'click', () => controller?.abort());
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'toolbar-capture' || message.windowId !== windowId || !Number.isInteger(message.tabId) || message.tabId < 0) return;
  if (chat || busy || imageLoading) { sendResponse({ captured: false }); return; }
  capture(message.tabId).then(captured => sendResponse({ captured }), () => sendResponse({ captured: false }));
  return true;
});
chrome.tabs.onActivated.addListener(info => {
  if (info.windowId !== windowId) return;
  tabId = info.tabId; invalidateDraft(); if (!chat && !busy) capture();
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (id !== tabId) return;
  if (change.status === 'loading' || change.url) invalidateDraft();
  if (!chat && !busy && (change.status === 'complete' || change.url)) capture();
});
async function boot() {
  windowId = (await chrome.windows.getCurrent()).id;
  const saved = await chrome.storage.local.get(['settings', 'modelCatalog']);
  settings = { ...settings, ...saved.settings }; modelCatalog = saved.modelCatalog || [];
  if (!Number.isInteger(settings.maxImages) || settings.maxImages < 1 || settings.maxImages > MAX_IMAGE_COUNT) settings.maxImages = DEFAULT_IMAGE_COUNT;
  if (!['same', 'codex', 'api'].includes(settings.titleProvider)) settings.titleProvider = 'same';
  if (typeof settings.titleModel !== 'string' || !/^[\w.:-]{1,150}$/.test(settings.titleModel)) settings.titleModel = 'gpt-6-luna';
  $('token').value = settings.token; $('theme').value = settings.theme; $('send-key').value = settings.sendKey; $('max-images').value = String(settings.maxImages); applyTheme(settings.theme);
  $('ai-title').checked = settings.aiTitle; $('retitle').checked = settings.retitle;
  $('title-provider').value = settings.titleProvider; $('title-model').value = settings.titleModel; updateTitleModelOptions();
  await renderPageAccess();
  db = await openStore(); await renderSkills();
  const session = (await chrome.storage.session.get(sessionKey()))[sessionKey()];
  if (session?.chatId) await loadChat(session.chatId);
  $('question').value = session?.draft || ''; updateSend(); updateHeader();
  if (!hasDataConsent(settings)) { showSetup(); return; }
  if (!settings.setupCompleted || !settings.token) showSetup();
  if (settings.nativeConnected) await withSetupWork(connectHelper);
  else if (settings.token) await withSetupWork(diagnoseConnection);
  if (!bridgeReady) showSetup();
  if (!chat) await capture();
}
updateSend();
await boot().catch(error => status('初期化できませんでした。' + error.message, true));
