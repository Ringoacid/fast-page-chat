import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createBridge } from '../server/http.mjs';
import { validateTitleRequest, cleanTitle, TITLE_INSTRUCTIONS } from '../server/title.mjs';
import { apiInput, codexInput } from '../server/prompt.mjs';
import { apiAnswer } from '../server/api.mjs';
import { CodexClient } from '../server/codex.mjs';
import { readSSE } from '../extension/stream.js';

const input = () => ({
  provider: 'codex', model: 'gpt-6-luna', pageTitle: 'Sample page', currentTitle: '最初の質問',
  messages: [
    { role: 'user', text: '最初の質問' }, { role: 'assistant', text: '最初の回答' },
    { role: 'user', text: '追加の質問' }, { role: 'assistant', text: '追加の回答' }
  ]
});

test('title requests use independent model and isolated untrusted conversation input', () => {
  const request = validateTitleRequest(input());
  assert.equal(request.model, 'gpt-6-luna');
  assert.equal(request.instructions, TITLE_INSTRUCTIONS);
  assert.deepEqual(apiInput(request), [{ role: 'user', content: request.titleInput }]);
  assert.deepEqual(codexInput(request), [{ type: 'text', text: request.titleInput }]);
  assert.equal(JSON.parse(request.titleInput).messages.at(-1).text, '追加の回答');
  assert.equal(cleanTitle('  # 「新しい名前」\n'), '新しい名前');
  assert.equal(cleanTitle('タイトル：記事の要点\n説明文'), '記事の要点');
});

test('title request rejects invalid model and forged roles', () => {
  for (const mutate of [
    body => { body.model = ''; },
    body => { body.messages[1].role = 'developer'; },
    body => { body.messages[1].text = 'x'.repeat(4001); }
  ]) { const body = input(); mutate(body); assert.throws(() => validateTitleRequest(body)); }
});

test('API title generation uses its own model and title instructions', async () => {
  const body = input(); body.provider = 'api'; body.model = 'gpt-6-luna';
  await apiAnswer(validateTitleRequest(body), () => {}, new AbortController().signal, {
    apiKey: 'test-only', fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.model, 'gpt-6-luna');
      assert.equal(request.instructions, TITLE_INSTRUCTIONS);
      assert.equal(request.input[0].role, 'user');
      assert.equal(JSON.parse(request.input[0].content).messages.length, 4);
      assert.equal(request.store, false);
      return new Response('data: {"type":"response.completed"}\n\n');
    }
  });
});

test('title endpoint returns cleaned model output and leaves chat route separate', async t => {
  const calls = [];
  const server = createBridge({
    token: 'test-token',
    codex: { models: async () => [], answer: async (request, emit) => { calls.push(request); emit({ type: 'delta', text: '「ページの仕組み」' }); } },
    apiAnswer: async () => { throw new Error('wrong provider'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/title`, {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(input())
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { title: 'ページの仕組み' });
  assert.equal(calls[0].model, 'gpt-6-luna');
  assert.equal(calls[0].instructions, TITLE_INSTRUCTIONS);
});

async function bridge(t, overrides) {
  const server = createBridge({ token: 'test-token', ...overrides });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, body) => fetch(base + path, {
    headers: { Authorization: 'Bearer test-token', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {})
  });
}

test('oversized asynchronous Codex titles return an error, interrupt upstream, and keep all routes usable', async t => {
  class AsyncCodex extends CodexClient {
    constructor() { super(); this.calls = []; this.threadNumber = 0; this.outputs = [['x'.repeat(600), 'x'.repeat(401)], ['新しいタイトル'], ['チャットの回答']]; }
    async start() {}
    async call(method, params) {
      this.calls.push({ method, params });
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'model/list') return { data: [{ model: 'gpt-6-luna', isDefault: true, supportedReasoningEfforts: [] }] };
      if (method === 'thread/start') return { thread: { id: 't' + ++this.threadNumber } };
      if (method === 'turn/start') {
        const turnId = 'u' + this.threadNumber, threadId = params.threadId, output = this.outputs.shift();
        // This callback is outside the Promise returned by call(), matching the
        // app-server notification path that previously terminated the process.
        setImmediate(() => {
          this.emit('notification', { method: 'turn/started', params: { threadId, turn: { id: turnId } } });
          for (const delta of output) this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId, itemId: 'a1', delta } });
          this.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
        });
        return { turn: { id: turnId } };
      }
      return {};
    }
  }
  const codex = new AsyncCodex(), send = await bridge(t, { codex });
  const failed = await send('/title', input());
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /タイトルが長すぎます/);
  assert.deepEqual(codex.calls.filter(c => c.method === 'turn/interrupt').map(c => c.params), [{ threadId: 't1', turnId: 'u1' }]);
  assert.equal(codex.listenerCount('notification'), 0);
  assert.equal(codex.listenerCount('failure'), 0);
  const health = await send('/health');
  assert.equal(health.status, 200); assert.equal((await health.json()).ok, true);
  const retry = await send('/title', input());
  assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), { title: '新しいタイトル' });
  const chat = await send('/chat', { provider: 'codex', question: '質問', page: { title: 'Page', url: 'https://example.com', text: 'Body' } });
  assert.equal(chat.status, 200);
  const events = await Array.fromAsync(readSSE(chat.body));
  assert.ok(events.some(event => event.type === 'delta' && event.text === 'チャットの回答'));
  assert.equal(events.at(-1).type, 'done');
  assert.equal(codex.calls.filter(c => c.method === 'thread/unsubscribe').length, 3);
});

test('empty titles fail without changing the subsequent title response', async t => {
  let output = '   \n';
  const send = await bridge(t, { codex: { answer: async (_request, emit) => emit({ type: 'delta', text: output }) } });
  const failed = await send('/title', input());
  assert.equal(failed.status, 502); assert.match((await failed.json()).error, /タイトルを生成できません/);
  output = '再生成したタイトル';
  const retry = await send('/title', input());
  assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), { title: output });
});

test('API titles preserve the length error and abort upstream without breaking later requests', async t => {
  let signal;
  let output = 'x'.repeat(1001);
  const send = await bridge(t, {
    apiAnswer: (request, emit, upstreamSignal) => {
      signal = upstreamSignal;
      return apiAnswer(request, emit, upstreamSignal, {
        apiKey: 'test-only', fetchImpl: async () => new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: output })}\n\ndata: {"type":"response.completed"}\n\n`)
      });
    }
  });
  const body = { ...input(), provider: 'api' };
  const failed = await send('/title', body);
  assert.equal(failed.status, 502); assert.match((await failed.json()).error, /タイトルが長すぎます/);
  assert.equal(signal.aborted, true);
  output = 'APIのタイトル';
  const retry = await send('/title', body);
  assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), { title: output });
});

test('a title timeout aborts generation and returns an error instead of a partial title', async t => {
  let signal;
  const started = Promise.withResolvers();
  const send = await bridge(t, {
    codex: { answer: async (_request, emit, upstreamSignal) => {
      signal = upstreamSignal; emit({ type: 'delta', text: '途中のタイトル' }); started.resolve();
      // Even if a provider returns normally after cancellation, partial output
      // must not become a successful title.
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    } }
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = send('/title', input());
  await started.promise;
  t.mock.timers.tick(60000);
  t.mock.timers.reset();
  const failed = await pending;
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /タイトル生成が完了しませんでした/);
  assert.equal(signal.aborted, true);
  const health = await send('/health');
  assert.equal(health.status, 200);
});
