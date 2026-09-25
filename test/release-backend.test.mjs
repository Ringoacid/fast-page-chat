import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, symlink } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { runtimePaths, prepareRuntime, loadConnectionToken, loadApiSettings, platformSecretStore, VERSION, PROTOCOL_VERSION } from '../server/config.mjs';
import { clearCodexDiagnostics } from '../server/diagnostics.mjs';
import { CodexClient } from '../server/codex.mjs';
import { createBridge } from '../server/http.mjs';
import { readSSE } from '../extension/stream.js';

async function isolatedPaths(t) {
  const root = resolve(await mkdtemp(join(tmpdir(), 'fpc-release-')));
  t.after(async () => {
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('fpc-release-')) throw new Error('Unsafe test cleanup path');
    await rm(root, { recursive: true, force: true });
  });
  return prepareRuntime(runtimePaths(root));
}
const secretStore = { format: 'test-sealed', protect: async value => Buffer.from(value).toString('base64'), unprotect: async value => Buffer.from(value, 'base64').toString() };
const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
const chatRequest = { provider: 'api', model: 'test-model', question: 'Test', page: { url: 'https://example.com/', title: 'Test', text: 'Fixture' }, history: [] };
async function bridge(t, overrides = {}) {
  const codex = { diagnostics: async () => ({ state: 'signed_out', message: 'Login needed' }), loginStatus: async () => ({ state: 'signed_out' }), startLogin: async () => ({ authUrl: 'https://auth.openai.com/test', loginId: 'login-1' }), stop: async () => {}, models: async () => [] };
  const server = createBridge({ token: 'test-token', codex, apiAnswer: async (_request, emit) => emit({ type: 'delta', text: 'Fixture answer' }), ...overrides });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { base: `http://127.0.0.1:${server.address().port}`, server, codex };
}
const post = (base, path, body = {}) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });

test('runtime data is relocatable and concurrent native bootstraps share one token', async t => {
  const paths = await isolatedPaths(t);
  assert.equal(paths.codexHome, resolve(paths.dataDir, 'codex-home'));
  const tokens = await Promise.all(Array.from({ length: 16 }, () => loadConnectionToken(paths)));
  assert.equal(new Set(tokens).size, 1);
  assert.match(tokens[0], /^[a-f0-9]{64}$/);
  await writeFile(paths.tokenPath, 'invalid-existing-key');
  await assert.rejects(loadConnectionToken(paths), /破損/);
  assert.equal(await readFile(paths.tokenPath, 'utf8'), 'invalid-existing-key');
});
test('API config saves protected credentials atomically, supports model-only edits and explicit key clearing', async t => {
  const paths = await isolatedPaths(t);
  const settings = await loadApiSettings(paths, { env: { OPENAI_API_KEY: 'environment-key', OPENAI_MODEL: 'old-model' }, secretStore });
  assert.equal(settings.get().apiKey, 'environment-key');
  await settings.save({ apiKey: 'test-private-key', model: 'new-model' });
  assert.ok(!(await readFile(paths.apiConfigPath, 'utf8')).includes('test-private-key'));
  await settings.save({ model: 'other-model' });
  const loaded = await loadApiSettings(paths, { env: { OPENAI_API_KEY: 'fallback' }, secretStore });
  assert.deepEqual(loaded.get(), { apiKey: 'test-private-key', model: 'other-model' });
  await assert.rejects(settings.save({ apiKey: 'key\nwith-header-injection' }), /不正/);
  assert.equal(settings.get().apiKey, 'test-private-key');
  await settings.save({ apiKey: '', model: '' });
  assert.deepEqual((await loadApiSettings(paths, { env: { OPENAI_API_KEY: 'fallback' }, secretStore })).get(), { apiKey: '', model: '' });
  assert.ok(!(await readdir(paths.dataDir)).some(name => name.endsWith('.tmp')));
});
test('Windows API key protection round trips through current-user DPAPI', { skip: process.platform !== 'win32' }, async () => {
  const store = platformSecretStore();
  const sealed = await store.protect('test-only-dpapi-key');
  assert.notEqual(sealed, 'test-only-dpapi-key');
  assert.equal(await store.unprotect(sealed), 'test-only-dpapi-key');
});
test('diagnostic cleanup removes only known files and preserves credentials and state', async t => {
  const paths = await isolatedPaths(t);
  await mkdir(resolve(paths.codexHome, 'log'));
  for (const name of ['logs_2.sqlite', 'logs_2.sqlite-wal', 'log/codex-login.log', 'auth.json', 'state_5.sqlite', 'logs_999.sqlite', 'log/unknown.log']) await writeFile(resolve(paths.codexHome, name), 'fixture');
  assert.equal(await clearCodexDiagnostics(paths), 3);
  for (const name of ['auth.json', 'state_5.sqlite', 'logs_999.sqlite', 'log/unknown.log']) assert.equal(await readFile(resolve(paths.codexHome, name), 'utf8'), 'fixture');
  assert.equal(await clearCodexDiagnostics(paths), 0);
  await assert.rejects(clearCodexDiagnostics({ ...paths, codexHome: paths.dataDir }), /不正/);
});

test('diagnostic cleanup accepts an ordinary Windows 8.3 data path', { skip: process.platform !== 'win32' }, async t => {
  const paths = await isolatedPaths(t);
  const env = { ...process.env }; delete env.PSModulePath;
  // Ask Windows for the real short-name alias; never manufacture an alias or
  // canonicalize the test input, which would hide the runner TEMP regression.
  const shortPath = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $filesystem=New-Object -ComObject Scripting.FileSystemObject; [Console]::Out.Write($filesystem.GetFolder([Console]::In.ReadToEnd()).ShortPath)'],
  { env, input: paths.dataDir, encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  if (!shortPath.includes('~')) { t.skip('The test volume does not provide 8.3 aliases.'); return; }
  await writeFile(resolve(paths.codexHome, 'logs_2.sqlite'), 'fixture');
  await writeFile(resolve(paths.codexHome, 'auth.json'), 'preserve');
  assert.equal(await clearCodexDiagnostics(runtimePaths(shortPath)), 1);
  assert.equal(await readFile(resolve(paths.codexHome, 'auth.json'), 'utf8'), 'preserve');
});
test('diagnostic cleanup rejects a redirected log directory before deleting any file', async t => {
  const paths = await isolatedPaths(t), outside = resolve(paths.dataDir, 'outside');
  await mkdir(outside);
  await writeFile(resolve(outside, 'codex-login.log'), 'preserve');
  await writeFile(resolve(paths.codexHome, 'logs_2.sqlite'), 'preserve');
  await symlink(outside, resolve(paths.codexHome, 'log'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(clearCodexDiagnostics(paths), /ファイル以外/);
  assert.equal(await readFile(resolve(outside, 'codex-login.log'), 'utf8'), 'preserve');
  assert.equal(await readFile(resolve(paths.codexHome, 'logs_2.sqlite'), 'utf8'), 'preserve');
});

test('diagnostic cleanup rejects a junction or symlink in an ancestor of the dedicated home', async t => {
  const paths = await isolatedPaths(t), linkedData = resolve(paths.dataDir, 'linked-data');
  const actualData = resolve(paths.dataDir, 'actual-data');
  const actualHome = resolve(actualData, 'codex-home');
  await mkdir(actualHome, { recursive: true });
  await writeFile(resolve(actualHome, 'logs_2.sqlite'), 'preserve');
  await symlink(actualData, linkedData, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(clearCodexDiagnostics(runtimePaths(linkedData)), /保存先がリンク/);
  assert.equal(await readFile(resolve(actualHome, 'logs_2.sqlite'), 'utf8'), 'preserve');
});
test('all setup and cleanup routes authenticate before reading or changing data', async t => {
  let writes = 0;
  const { base } = await bridge(t, { clearLogs: async () => { writes++; return 0; } });
  for (const [method, path] of [['GET', '/health'], ['GET', '/diagnostics'], ['GET', '/login/status'], ['POST', '/login/start'], ['POST', '/settings/api'], ['POST', '/logs/clear'], ['POST', '/shutdown']]) {
    const response = await fetch(base + path, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(response.status, 401, path);
    assert.equal((await fetch(base + path, { method, headers: { ...headers, Origin: 'https://example.com' }, ...(method === 'POST' ? { body: '{}' } : {}) })).status, 403, path);
  }
  assert.equal(writes, 0);
});
test('health and diagnostics expose protocol and configuration without API credentials', async t => {
  const paths = await isolatedPaths(t);
  const apiSettings = await loadApiSettings(paths, { env: {}, secretStore });
  const { base } = await bridge(t, { apiSettings });
  assert.deepEqual(await (await fetch(base + '/health', { headers })).json(), { ok: true, app: 'fast-page-chat', version: VERSION, protocolVersion: PROTOCOL_VERSION, apiConfigured: false, apiModel: '' });
  const response = await post(base, '/settings/api', { apiKey: 'test-secret-no-echo', model: 'test-model' });
  assert.deepEqual(await response.json(), { ok: true, apiConfigured: true, apiModel: 'test-model' });
  const diagnostic = await (await fetch(base + '/diagnostics', { headers })).json();
  assert.equal(diagnostic.codex.state, 'signed_out'); assert.equal(diagnostic.api.state, 'configured');
  assert.match(diagnostic.api.message, /未確認/);
  assert.ok(!JSON.stringify(diagnostic).includes('test-secret-no-echo'));
  assert.equal((await post(base, '/settings/api', { apiKey: null })).status, 400);
  assert.equal((await post(base, '/settings/api', { apiKey: 'a'.repeat(16001) })).status, 413);
});
test('cleanup cannot interrupt a running answer and waits for Codex exit before deleting', async t => {
  const events = [], started = Promise.withResolvers(), release = Promise.withResolvers();
  const { base, codex } = await bridge(t, { clearLogs: async () => { events.push('delete'); return 2; }, apiAnswer: async (_request, emit) => { started.resolve(); await release.promise; emit({ type: 'delta', text: 'done' }); } });
  codex.stop = async () => { events.push('stop'); };
  const chat = await post(base, '/chat', chatRequest); await started.promise;
  assert.equal((await post(base, '/logs/clear')).status, 409);
  assert.equal((await post(base, '/shutdown')).status, 409);
  assert.deepEqual(events, []);
  release.resolve(); await Array.fromAsync(readSSE(chat.body));
  assert.deepEqual(await (await post(base, '/logs/clear')).json(), { ok: true, count: 2 });
  assert.deepEqual(events, ['stop', 'delete']);
});
test('maintenance blocks newly arriving model calls and preserves logs when child stop fails', async t => {
  const stopStarted = Promise.withResolvers(), releaseStop = Promise.withResolvers(); let deleted = false;
  const { base, codex } = await bridge(t, { clearLogs: async () => { deleted = true; return 1; } });
  codex.stop = async () => { stopStarted.resolve(); await releaseStop.promise; throw new Error('exit unconfirmed'); };
  const clear = post(base, '/logs/clear'); await stopStarted.promise;
  assert.equal((await fetch(base + '/models', { headers })).status, 409);
  assert.equal((await post(base, '/chat', chatRequest)).status, 409);
  releaseStop.resolve(); assert.equal((await clear).status, 503); assert.equal(deleted, false);
  assert.equal((await fetch(base + '/health', { headers })).status, 200);
});
test('authenticated shutdown is acknowledged before the injected shutdown callback', async t => {
  const stopped = Promise.withResolvers(); let calls = 0;
  const { base } = await bridge(t, { shutdown: () => { calls++; stopped.resolve(); } });
  assert.deepEqual(await (await post(base, '/shutdown')).json(), { ok: true });
  await stopped.promise; assert.equal(calls, 1);
});
test('Codex login uses app-server without inference, propagates completion and applies privacy settings', async t => {
  let client;
  t.after(() => client?.stop());
  const paths = await isolatedPaths(t);
  const fakeServer = `
    const {createInterface}=require('node:readline'); let loggedIn=false;
    const write=value=>process.stdout.write(JSON.stringify(value)+'\\n');
    createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;
      let result={};
      if(m.method==='initialize'&&m.params.clientInfo.version!=='${VERSION}')throw Error('wrong version');
      if(m.method==='account/read')result={account:loggedIn?{type:'chatgpt'}:null};
      if(m.method==='model/list')result={data:[{model:'fixture-model'}]};
      if(m.method==='account/login/start'){
        result={type:'chatgpt',loginId:'login-fixture',authUrl:'https://auth.openai.com/fixture'};
        setTimeout(()=>{loggedIn=true;write({method:'account/login/completed',params:{loginId:'login-fixture',success:true,error:null}});},50);
      }
      if(m.method==='turn/start')throw Error('inference forbidden');
      write({id:m.id,result});
    });`;
  client = new CodexClient({ paths, spawnImpl: (_file, args, options) => {
    assert.equal(options.env.CODEX_HOME, paths.codexHome);
    assert.equal(options.env.CODEX_SQLITE_HOME, paths.codexHome);
    assert.equal(options.env.RUST_LOG, 'off');
    for (const required of ['history.persistence="none"', 'feedback.enabled=false', 'analytics.enabled=false', 'otel.log_user_prompt=false']) assert.ok(args.includes(required));
    return spawn(process.execPath, ['-e', fakeServer], options);
  } });
  assert.equal((await client.diagnostics()).state, 'signed_out');
  const completion = once(client, 'notification');
  const first = await client.startLogin(); assert.equal(first.loginId, 'login-fixture');
  assert.deepEqual(await client.startLogin(), first);
  await completion;
  assert.equal((await client.loginStatus()).state, 'ready');
  const diagnostics = await client.diagnostics();
  assert.equal(diagnostics.state, 'ready'); assert.equal(diagnostics.models[0].model, 'fixture-model');
});
