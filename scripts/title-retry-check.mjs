// Desktop MV3 regression checks against the real panel and a local mock bridge.
// No model requests, personal browser profile, or production connection key.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBridge } from '../server/http.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
await mkdir('test-results', { recursive: true });
const fixture = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html lang="ja"><title>タイトル再生成の確認</title><main><h1>記事を読むための道具</h1><p>ページを参照しながら質問を続けられます。</p></main></html>');
});
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');

const titlePlans = [], titleRequests = [], chatRequests = [];
function titlePlan({ title, error, delayed = false }) {
  let started, release, complete;
  const plan = { title, error, started: new Promise(resolve => { started = resolve; }), completed: new Promise(resolve => { complete = resolve; }) };
  plan.begin = started;
  plan.complete = complete;
  plan.ready = delayed ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  plan.release = release || (() => {});
  titlePlans.push(plan);
  return plan;
}
async function waitUntilStarted(plan) {
  let timer;
  try {
    await Promise.race([plan.started, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The expected /title request did not start.')), 10000);
    })]);
  } finally { clearTimeout(timer); }
}
async function waitUntilCanceled(plan) {
  let timer;
  try {
    await Promise.race([plan.completed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The stale /title request was not canceled.')), 10000);
    })]);
    assert.equal(plan.aborted, true, 'An obsolete title generation must be aborted.');
  } finally { clearTimeout(timer); }
}
const answer = async (request, emit, signal) => {
  if (!request.titleInput) {
    chatRequests.push(request);
    emit({ type: 'delta', text: `## 回答${chatRequests.length}\n\n質問「${request.question}」への回答です。本文の内容と会話はそのまま保存されます。` });
    return;
  }
  titleRequests.push(request);
  const plan = titlePlans.shift();
  if (!plan) throw new Error('Unexpected title request in regression check.');
  plan.begin();
  let abort;
  try {
    await Promise.race([plan.ready, new Promise((_, reject) => {
      abort = () => reject(signal.reason || new Error('Title request aborted.'));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    })]);
    if (plan.error) throw new Error(plan.error);
    emit({ type: 'delta', text: plan.title });
  } finally { plan.aborted = signal.aborted; signal.removeEventListener('abort', abort); plan.complete(); }
};
const bridge = createBridge({ token: 'title-retry-test-only', apiConfigured: true,
  codex: { diagnostics: async () => ({ state: 'ready', message: 'テスト用Codexに接続済みです。' }), models: async () => [], answer }, apiAnswer: answer });
bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');

let context, panel;
try {
  const extension = resolve('test-results/title-retry-extension');
  await cp(resolve('extension'), extension, { recursive: true });
  for (const name of ['panel.js', 'setup.js', 'manifest.json']) {
    const file = resolve(extension, name);
    await writeFile(file, (await readFile(file, 'utf8')).replaceAll('127.0.0.1:4318', '127.0.0.1:' + bridge.address().port));
  }
  context = await chromium.launchPersistentContext(resolve('test-results/title-retry-profile'), {
    headless: true, channel: 'chromium', executablePath: process.env.CHROMIUM_BIN || undefined,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
    viewport: { width: 390, height: 900 }
  });
  context.setDefaultTimeout(10000);
  let worker = context.serviceWorkers()[0]; if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(async () => {
    await chrome.storage.local.clear(); await chrome.storage.session.clear();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('fast-page-chat'); request.onsuccess = resolve; request.onerror = reject;
    });
    await chrome.storage.local.set({ settings: {
      token: 'title-retry-test-only', provider: 'api', apiModel: 'test-model', theme: 'light', privacyConsentVersion: 1, setupCompleted: true,
      titleProvider: 'api', titleModel: 'test-model', customModels: { codex: [], api: ['test-model'] }
    } });
  });
  const source = await context.newPage();
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/title-fixture`;
  await source.goto(fixtureUrl);
  const fixtureTab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), fixtureUrl);
  assert.ok(fixtureTab, 'The independent fixture tab must be available.');
  panel = await context.newPage();
  const errors = [];
  panel.on('pageerror', error => errors.push(error.message));
  await panel.addInitScript(targetId => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async info => {
      if (!info.active) return query(info);
      const tab = await chrome.tabs.get(targetId); delete tab.url; return [tab];
    };
  }, fixtureTab.id);
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  const ready = () => panel.waitForFunction(() => document.querySelector('#source-text').textContent.includes('ページを参照しながら'));
  const idle = count => panel.waitForFunction(count => document.querySelectorAll('.assistant').length === count && document.querySelector('#conversation').getAttribute('aria-busy') === 'false', count);
  const titleIs = title => panel.waitForFunction(title => document.querySelector('#chat-title').textContent === title, title);
  const send = async question => { await panel.locator('#question').fill(question); await panel.getByRole('button', { name: '送信', exact: true }).click(); };
  const retryIdle = () => panel.waitForFunction(() => !document.querySelector('#title-retry').disabled && document.querySelector('#title-retry').textContent.trim() === 'タイトルを再生成する');
  const failed = async message => {
    await panel.locator('#title-notice').waitFor({ state: 'visible' });
    await panel.locator('#title-error').filter({ hasText: message }).waitFor();
    await retryIdle();
  };
  const savedChat = () => panel.evaluate(async () => {
    const windowId = (await chrome.windows.getCurrent()).id;
    const key = 'panel:' + windowId;
    const session = (await chrome.storage.session.get(key))[key];
    const { openStore } = await import('./chat-store.js');
    const store = await openStore();
    try { return await store.getChat(session.chatId); } finally { store.db.close(); }
  });
  const retry = async plan => {
    await panel.getByRole('button', { name: 'タイトルを再生成する', exact: true }).click();
    await waitUntilStarted(plan);
    assert.equal(await panel.locator('#title-retry').isDisabled(), true);
    assert.equal((await panel.locator('#title-retry').textContent()).trim(), '再生成中…');
  };
  const finish = async plan => {
    const responsePromise = panel.waitForResponse(response => new URL(response.url()).pathname === '/title');
    plan.release();
    const response = await responsePromise;
    await response.finished();
    await retryIdle();
  };
  const openHistoryChat = async title => {
    await panel.getByRole('button', { name: 'チャット履歴', exact: true }).click();
    await panel.locator('.history-link').filter({ hasText: title }).click();
    await titleIs(title);
  };
  await ready();
  assert.equal(await panel.locator('#title-notice').isVisible(), false);

  // A failed automatic title leaves the answer and the initial name untouched.
  const questionA = '記事の要点を教えて';
  titlePlan({ error: 'タイトル用モデルを利用できません。設定を確認してください。' });
  await send(questionA); await idle(1);
  await failed('タイトル用モデルを利用できません');
  await titleIs(questionA);
  const original = await savedChat();
  assert.equal(original.messages.length, 2);
  assert.equal(original.messages[1].status, 'complete');
  assert.match(original.titleFailure, /タイトル用モデルを利用できません/);
  assert.equal(chatRequests.length, 1);

  // Screenshots are real panel renders, including a narrow side panel.
  for (const [theme, width, suffix] of [['light', 390, 'light'], ['dark', 390, 'dark'], ['dark', 320, 'narrow-320']]) {
    await panel.setViewportSize({ width, height: 900 });
    await panel.getByRole('button', { name: '設定', exact: true }).click();
    await panel.locator('#theme').selectOption(theme);
    await panel.locator('#settings-dialog [data-close]').click();
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await panel.getByRole('button', { name: 'タイトルを再生成する', exact: true }).isVisible(), true);
    await panel.screenshot({ path: `test-results/title-${suffix}.png`, animations: 'disabled' });
  }
  await panel.setViewportSize({ width: 390, height: 900 });

  // The failure is attached to the persisted chat, and reload itself never retries.
  await panel.reload(); await idle(1); await failed('タイトル用モデルを利用できません');
  assert.equal(titleRequests.length, 1);
  assert.equal((await savedChat()).id, original.id);

  // Automatic naming preferences must not prevent an explicit recovery action.
  await panel.getByRole('button', { name: '設定', exact: true }).click();
  await panel.locator('#ai-title').uncheck();
  await panel.locator('#retitle').uncheck();
  await panel.locator('#settings-dialog [data-close]').click();
  await panel.waitForFunction(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    return settings.aiTitle === false && settings.retitle === false;
  });
  await failed('タイトル用モデルを利用できません');

  // A second failure restores the retry button without resending the question.
  const retryFailure = titlePlan({ error: '一時的なタイトル生成エラーです。もう一度試してください。', delayed: true });
  await retry(retryFailure);
  assert.equal(chatRequests.length, 1);
  assert.equal(titleRequests.length, 2);
  await finish(retryFailure); await failed('一時的なタイトル生成エラー');
  assert.deepEqual((await savedChat()).messages, original.messages);
  assert.match((await savedChat()).titleFailure, /一時的なタイトル生成エラー/);

  // A successful retry updates only the title and clears its persistent failure.
  const generatedTitle = '記事の要点と理解のメモ';
  const retrySuccess = titlePlan({ title: generatedTitle, delayed: true });
  await retry(retrySuccess);
  assert.equal(chatRequests.length, 1);
  await finish(retrySuccess); await titleIs(generatedTitle);
  await panel.locator('#title-notice').waitFor({ state: 'hidden' });
  const recovered = await savedChat();
  assert.ok(!recovered.titleFailure);
  assert.deepEqual(recovered.messages, original.messages);
  assert.equal(titleRequests.length, 3);
  console.log('PASS: title failure persistence; retry busy state; repeated failure; successful title-only retry; original answer retained.');
  console.log('PASS: explicit title retry still succeeds with both automatic naming preferences switched off.');
  await panel.getByRole('button', { name: '設定', exact: true }).click();
  await panel.locator('#ai-title').check();
  await panel.locator('#retitle').check();
  await panel.locator('#settings-dialog [data-close]').click();

  // Failure of a later automatic rename also preserves the existing title.
  titlePlan({ error: '後続回答のタイトル更新に失敗しました。' });
  await send('根拠も詳しく説明して'); await idle(2); await failed('後続回答のタイトル更新');
  await titleIs(generatedTitle);
  const continued = await savedChat();
  assert.equal(continued.messages.length, 4);
  assert.equal(chatRequests.length, 2);
  assert.equal(chatRequests.at(-1).history.length, 2);
  await panel.locator('#new-chat').click(); await ready();
  assert.equal(await panel.locator('#title-notice').isVisible(), false);
  titlePlan({ title: '別チャットのタイトル' });
  await send('別の話題を考えて'); await idle(1); await titleIs('別チャットのタイトル');
  assert.equal(await panel.locator('#title-notice').isVisible(), false);
  await openHistoryChat(generatedTitle); await idle(2); await failed('後続回答のタイトル更新');
  assert.equal((await savedChat()).id, original.id);
  console.log('PASS: continuation failure preserves title; errors stay scoped to their chat across history switches and reload.');

  // A title response arriving after a manual rename must not overwrite that name.
  const staleRename = titlePlan({ title: '上書きしてはいけない古いAIタイトル', delayed: true });
  await retry(staleRename);
  const chatCountBeforeRename = chatRequests.length;
  await panel.getByRole('button', { name: 'チャットの操作', exact: true }).click();
  await panel.getByRole('button', { name: '名前を変更する', exact: true }).click();
  await panel.locator('#history-rename-title').fill('自分で決めたチャット名');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await panel.locator('.history-link').filter({ hasText: '自分で決めたチャット名' }).click();
  await titleIs('自分で決めたチャット名');
  await waitUntilCanceled(staleRename); await retryIdle();
  await titleIs('自分で決めたチャット名');
  const renamed = await savedChat();
  assert.equal(renamed.title, '自分で決めたチャット名');
  assert.equal(renamed.titleEdited, true);
  assert.deepEqual(renamed.messages, continued.messages);
  assert.equal(chatRequests.length, chatCountBeforeRename);

  // New messages arriving during a title retry invalidate that old response.
  await panel.locator('#new-chat').click(); await ready();
  titlePlan({ error: '新しい会話のタイトル生成に失敗しました。' });
  const questionC = '別の要約を作って';
  await send(questionC); await idle(1); await failed('新しい会話のタイトル生成');
  const staleMessages = titlePlan({ title: '新しい質問を知らない古いタイトル', delayed: true });
  await retry(staleMessages);
  const newerTitle = titlePlan({ title: '追加質問を反映した最新タイトル' });
  await send('追加の質問と今後の課題'); await idle(2);
  await waitUntilCanceled(staleMessages); await waitUntilStarted(newerTitle);
  await titleIs('追加質問を反映した最新タイトル'); await retryIdle();
  const latest = await savedChat();
  assert.equal(latest.messages.length, 4);
  assert.equal(latest.messages.at(-2).text, '追加の質問と今後の課題');
  assert.notEqual(latest.title, '新しい質問を知らない古いタイトル');
  assert.notEqual(await panel.locator('#chat-title').textContent(), '新しい質問を知らない古いタイトル');
  console.log('PASS: delayed title responses cannot overwrite manual names or newer conversation state.');

  // Pause exactly inside the AI title's saveChat promise. A user's rename is
  // submitted while that write is pending, so its persistence queues behind it.
  // This checks both the in-memory title and the revision of the later write.
  await panel.locator('#new-chat').click(); await ready();
  titlePlan({ error: '保存競合の再試行を確認します。' });
  await send('保存競合を確認する質問'); await idle(1); await failed('保存競合の再試行');
  const beforeSaveRace = await savedChat();
  const aiRaceTitle = '保存中に手動変更されるAIタイトル';
  const manualRaceTitle = '保存競合でも保持する手動タイトル';
  const saveRacePlan = titlePlan({ title: aiRaceTitle, delayed: true });
  await panel.evaluate(async pausedTitle => {
    const { openStore } = await import('./chat-store.js');
    const store = await openStore();
    const prototype = Object.getPrototypeOf(store), originalSave = prototype.saveChat;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    window.titleSaveStarted = false;
    window.releaseTitleSave = release;
    window.restoreTitleSave = () => {
      release(); prototype.saveChat = originalSave; store.db.close();
      delete window.titleSaveStarted; delete window.releaseTitleSave; delete window.restoreTitleSave;
    };
    prototype.saveChat = async function (record) {
      if (record.title === pausedTitle && !record.titleEdited) {
        window.titleSaveStarted = true;
        await gate;
      }
      return originalSave.call(this, record);
    };
  }, aiRaceTitle);
  try {
    await retry(saveRacePlan);
    saveRacePlan.release();
    await panel.waitForFunction(() => window.titleSaveStarted === true);
    await panel.getByRole('button', { name: 'チャットの操作', exact: true }).click();
    await panel.getByRole('button', { name: '名前を変更する', exact: true }).click();
    await panel.locator('#history-rename-title').fill(manualRaceTitle);
    await panel.getByRole('button', { name: '保存', exact: true }).click();
    await panel.waitForFunction(() => document.querySelector('#history-rename-title')?.disabled === true);
    await panel.evaluate(() => window.releaseTitleSave());
    await panel.locator('.history-link').filter({ hasText: manualRaceTitle }).click();
    await titleIs(manualRaceTitle); await retryIdle();
    const afterSaveRace = await savedChat();
    assert.equal(afterSaveRace.title, manualRaceTitle);
    assert.equal(afterSaveRace.titleEdited, true);
    assert.ok(!afterSaveRace.titleFailure);
    assert.deepEqual(afterSaveRace.messages, beforeSaveRace.messages);
    assert.equal(afterSaveRace.revision, beforeSaveRace.revision + 2, 'Both queued metadata saves must advance the revision.');
  } finally {
    await panel.evaluate(() => window.restoreTitleSave?.());
  }
  await panel.reload(); await idle(1); await titleIs(manualRaceTitle);
  assert.equal((await savedChat()).title, manualRaceTitle);
  assert.equal(await panel.locator('#title-notice').isVisible(), false);
  console.log('PASS: a manual rename queued behind an in-flight AI title save retains its title and valid revision, including after reload.');
  assert.deepEqual(errors, []);
  assert.equal(titlePlans.length, 0);
  console.log('Screenshots: test-results/title-light.png, title-dark.png, title-narrow-320.png. All model responses were mocked.');
} catch (error) {
  if (panel && !panel.isClosed()) {
    await panel.screenshot({ path: 'test-results/title-failure.png', animations: 'disabled' }).catch(() => {});
    console.log('Panel status:', await panel.locator('#status').textContent().catch(() => 'unavailable'));
    console.log('Title notice:', await panel.locator('#title-notice').textContent().catch(() => 'unavailable'));
  }
  throw error;
} finally {
  await context?.close();
  fixture.closeAllConnections(); fixture.close(); bridge.closeAllConnections(); bridge.close();
}
