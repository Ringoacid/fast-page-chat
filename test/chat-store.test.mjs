import test from 'node:test';
import assert from 'node:assert/strict';
import { createChat, conversationInput, recoverInterrupted, sortChats, chatMarkdown } from '../extension/chat-store.js';
const page = { title: 'A page', url: 'https://example.com', text: 'Original body' };
test('new chat owns an independent snapshot and unique ID', () => {
  const source = { ...page }, a = createChat(source, 'api', 'test-model', 'Hello\nthere', 123), b = createChat(source, 'codex', '', 'Hi', 124);
  source.text = 'New page'; assert.equal(a.page.text, 'Original body'); assert.notEqual(a.id, b.id); assert.equal(a.title, 'Hello there'); assert.equal(a.updatedAt, 123);
});
test('only the most recent six completed pairs are sent, failed turns stay out', () => {
  const messages = [];
  for (let i = 0; i < 9; i++) messages.push({ role: 'user', text: 'Q' + i }, { role: 'assistant', text: 'A' + i, status: 'complete' });
  messages.push({ role: 'user', text: 'failed question' }, { role: 'assistant', text: 'partial', status: 'interrupted' });
  const input = conversationInput(messages); assert.equal(input.length, 12); assert.equal(input[0].content, 'Q3'); assert.equal(input.at(-1).content, 'A8');
});
test('interrupted stream is recovered without changing complete responses', () => {
  const chat = { messages: [{ status: 'streaming', text: 'partial' }, { status: 'complete', text: 'done' }] };
  assert.equal(recoverInterrupted(chat), true); assert.deepEqual(chat.messages.map(m => m.status), ['interrupted', 'complete']); assert.equal(recoverInterrupted(chat), false);
});
test('history search includes content and pinning takes precedence over recency', () => {
  const a = createChat(page, 'api', '', 'First', 1), b = createChat(page, 'api', '', 'Second', 2); a.pinned = true;
  b.messages = [{ text: 'NEEDLE' }]; assert.equal(sortChats([b, a])[0].id, a.id); assert.deepEqual(sortChats([a, b], 'needle').map(c => c.id), [b.id]);
});
test('export includes source and marks interrupted messages', () => {
  const chat = createChat(page, 'api', '', 'Test'); chat.messages = [{ role: 'assistant', text: 'Partial answer', status: 'interrupted' }];
  assert.match(chatMarkdown(chat), /https:\/\/example.com/); assert.match(chatMarkdown(chat), /未完了/);
});
