import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDataConsent, requireDataConsent, resolveTitleConnection, trustedLoginUrl, validateNativeConnection, BRIDGE_ENDPOINT } from '../extension/setup.js';

test('page access requires explicit consent to the current disclosure', () => {
  for (const settings of [{}, { privacyConsentVersion: 0 }, { privacyConsentVersion: true }, { privacyConsentVersion: 2 }]) {
    assert.equal(hasDataConsent(settings), false);
    assert.throws(() => requireDataConsent(settings), /取り扱い/);
  }
  assert.doesNotThrow(() => requireDataConsent({ privacyConsentVersion: 1 }));
});

test('new title settings follow each chat provider and model without a Codex dependency', () => {
  assert.deepEqual(resolveTitleConnection({ titleProvider: 'same', titleModel: 'unused' }, { provider: 'api', model: 'api-model' }), { provider: 'api', model: 'api-model' });
  assert.deepEqual(resolveTitleConnection({}, { provider: 'codex', model: '' }), { provider: 'codex', model: '' });
  assert.deepEqual(resolveTitleConnection({ titleProvider: 'codex', titleModel: 'old-model' }, { provider: 'api', model: 'api-model' }), { provider: 'codex', model: 'old-model' });
});

test('native bootstrap cannot change endpoint or accept an incompatible bridge', () => {
  const reply = { ok: true, protocolVersion: 1, endpoint: BRIDGE_ENDPOINT, token: 'a'.repeat(64) };
  assert.equal(validateNativeConnection(reply), reply);
  for (const altered of [{ endpoint: 'https://attacker.example' }, { protocolVersion: 2 }, { token: '' }, { ok: false }]) {
    assert.throws(() => validateNativeConnection({ ...reply, ...altered }));
  }
});

test('only HTTPS login URLs on exact trusted authentication hosts may open', () => {
  assert.equal(trustedLoginUrl('https://auth.openai.com/oauth/authorize?state=abc'), 'https://auth.openai.com/oauth/authorize?state=abc');
  assert.equal(trustedLoginUrl('https://chatgpt.com/auth/login'), 'https://chatgpt.com/auth/login');
  for (const url of ['http://auth.openai.com/', 'https://auth.openai.com.attacker.example/', 'https://attacker.example/', 'javascript:alert(1)', 'https://x@auth.openai.com/', 'https://auth.openai.com:8443/']) assert.throws(() => trustedLoginUrl(url));
});
