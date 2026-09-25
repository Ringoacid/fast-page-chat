import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { CodexClient } from '../server/codex.mjs';

class FakeCodex extends CodexClient {
  constructor(mode) { super(); this.mode = mode; this.calls = []; }
  async start() {}
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: this.mode === 'logged-out' ? null : { type: 'chatgpt' } };
    if (method === 'model/list') return { data: [{ model: 'sample', isDefault: true, inputModalities: this.mode === 'text-only' ? ['text'] : ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'medium' }] };
    if (method === 'thread/start') return { thread: { id: 't1' } };
    if (method === 'turn/start') {
      // Deliberately deliver notifications before the start response.
      this.emit('notification', { method: 'turn/started', params: { threadId: 't1', turn: { id: 'u1' } } });
      this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'other-tab', itemId: 'wrong', delta: 'PRIVATE' } });
      this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 't1', itemId: 'a1', delta: '日本語' } });
      this.emit('notification', { method: 'item/completed', params: { threadId: 't1', item: { type: 'agentMessage', id: 'a1', text: '日本語' } } });
      if (this.mode !== 'slow') this.emit('notification', { method: 'turn/completed', params: { threadId: 't1', turn: { id: 'u1', status: this.mode === 'failure' ? 'failed' : 'completed', error: this.mode === 'failure' ? { message: 'provider failed' } : null } } });
      return { turn: { id: 'u1' } };
    }
    return {};
  }
}
const request = { model: '', page: { title: 'Article', url: 'https://example.com', text: 'Hello' }, history: [], question: '翻訳して' };
test('Codex filters other threads, handles early events without duplicating final text, and releases thread', async () => {
  const client = new FakeCodex(); const events = [];
  await client.answer(request, e => events.push(e), new AbortController().signal);
  assert.deepEqual(events, [{ type: 'delta', text: '日本語' }]);
  assert.equal(client.calls.find(c => c.method === 'turn/start').params.effort, 'low');
  assert.equal(client.calls.find(c => c.method === 'thread/start').params.sandbox, 'read-only');
  assert.equal(client.calls.at(-1).method, 'thread/unsubscribe');
  assert.equal(client.listenerCount('notification'), 0);
});
test('Codex errors and missing login are surfaced', async () => {
  for (const mode of ['failure', 'logged-out']) {
    const client = new FakeCodex(mode);
    await assert.rejects(client.answer(request, () => {}, new AbortController().signal));
    assert.equal(client.listenerCount('notification'), 0);
  }
});
test('Codex cancellation sends turn/interrupt and cleans listeners', async () => {
  const client = new FakeCodex('slow'); const controller = new AbortController();
  await assert.rejects(client.answer(request, () => queueMicrotask(() => controller.abort()), controller.signal));
  assert.ok(client.calls.some(c => c.method === 'turn/interrupt' && c.params.turnId === 'u1'));
  assert.equal(client.calls.at(-1).method, 'thread/unsubscribe');
  assert.equal(client.listenerCount('notification'), 0);
});
test('Codex forwards selected effort and images as native input, not JSON text', async () => {
  const client = new FakeCodex();
  const images = [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', label: 'Diagram' }];
  await client.answer({ ...request, effort: 'high', images }, () => {}, new AbortController().signal);
  const turn = client.calls.find(c => c.method === 'turn/start').params;
  assert.equal(turn.effort, 'high');
  assert.deepEqual(turn.input.at(-1), { type: 'image', url: images[0].dataUrl });
  assert.ok(!turn.input[0].text.includes('base64'));
});
test('Codex rejects unsupported effort or images before starting any thread', async () => {
  for (const [mode, extra] of [['normal', { effort: 'ultra' }], ['text-only', { images: [{ dataUrl: 'data:image/png;base64,AAAA' }] }]]) {
    const client = new FakeCodex(mode);
    await assert.rejects(client.answer({ ...request, ...extra }, () => {}, new AbortController().signal));
    assert.ok(!client.calls.some(c => c.method === 'thread/start'));
  }
});

test('Codex catches asynchronous output handler failures and interrupts the turn only once', async () => {
  for (const method of ['item/agentMessage/delta', 'item/completed']) {
    class AsyncCodex extends FakeCodex {
      async call(name, params) {
        if (name !== 'turn/start') return super.call(name, params);
        this.calls.push({ method: name, params });
        setImmediate(() => {
          this.emit('notification', { method: 'turn/started', params: { threadId: 't1', turn: { id: 'u1' } } });
          this.emit('notification', { method, params: { threadId: 't1', itemId: 'a1', delta: 'output', item: { id: 'a1', type: 'agentMessage', text: 'output' } } });
          this.emit('notification', { method: 'turn/completed', params: { threadId: 't1', turn: { id: 'u1', status: 'completed' } } });
        });
        return { turn: { id: 'u1' } };
      }
    }
    const client = new AsyncCodex(), controller = new AbortController();
    const error = new Error('output rejected');
    await assert.rejects(client.answer(request, () => { throw error; }, controller.signal), error);
    controller.abort();
    assert.equal(client.calls.filter(c => c.method === 'turn/interrupt').length, 1);
    assert.equal(client.calls.at(-1).method, 'thread/unsubscribe');
    assert.equal(client.listenerCount('notification'), 0);
    assert.equal(client.listenerCount('failure'), 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('Codex remembers cancellation and output failures before the turn ID arrives', async () => {
  for (const cause of ['abort', 'output']) {
    const started = Promise.withResolvers(), startResponse = Promise.withResolvers();
    class DelayedCodex extends FakeCodex {
      async call(method, params) {
        if (method !== 'turn/start') return super.call(method, params);
        this.calls.push({ method, params }); started.resolve();
        return startResponse.promise;
      }
    }
    const client = new DelayedCodex(), controller = new AbortController(), error = new Error(cause);
    const rejected = assert.rejects(client.answer(request, () => { throw error; }, controller.signal), error);
    await started.promise;
    if (cause === 'abort') controller.abort(error);
    else client.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 't1', itemId: 'a1', delta: 'output' } });
    await rejected;
    assert.equal(client.calls.filter(c => c.method === 'turn/interrupt').length, 0);
    startResponse.resolve({ turn: { id: 'late-turn' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(client.calls.filter(c => c.method === 'turn/interrupt').map(c => c.params), [{ threadId: 't1', turnId: 'late-turn' }]);
    assert.equal(client.listenerCount('notification'), 0);
    assert.equal(client.listenerCount('failure'), 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});
