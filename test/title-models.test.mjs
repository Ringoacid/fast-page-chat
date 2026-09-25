import test from 'node:test';
import assert from 'node:assert/strict';
import { titleModelOptions } from '../extension/title-models.js';

test('title model choices follow the selected provider and keep Luna as default', () => {
  const catalog = [{ model: 'gpt-6-sol', displayName: 'GPT-6 Sol' }, { model: 'codex-only', displayName: 'Codex only' }];
  const custom = { api: ['api-only'] };
  const codex = titleModelOptions('codex', catalog, custom, 'api-default').map(item => item.model);
  const api = titleModelOptions('api', catalog, custom, 'api-default').map(item => item.model);
  assert.deepEqual(codex, ['gpt-6-luna', 'gpt-6-sol', 'codex-only']);
  assert.deepEqual(api, ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'api-default', 'api-only']);
});

test('a previously selected model remains selectable after upgrading from free input', () => {
  assert.deepEqual(titleModelOptions('codex', [], {}, '', 'saved-model').map(item => item.model), ['gpt-6-luna', 'saved-model']);
});
