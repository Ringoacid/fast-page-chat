import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { decodeMessage, encodeMessage, validOrigin, ensureBridge } from '../server/native-host.mjs';
import { runtimePaths } from '../server/config.mjs';

test('native bootstrap accepts one framed connect message and rejects extra data and arbitrary operations', () => {
  const frame = encodeMessage({ type: 'connect' });
  assert.equal(decodeMessage(frame.subarray(0, 3)), null);
  assert.equal(decodeMessage(frame.subarray(0, 8)), null);
  assert.deepEqual(decodeMessage(frame), { type: 'connect' });
  for (const value of [{ type: 'exec' }, { type: 'connect', endpoint: 'https://evil.test' }]) assert.throws(() => decodeMessage(encodeMessage(value)));
  assert.throws(() => decodeMessage(Buffer.concat([frame, frame])));
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(65535); assert.throws(() => decodeMessage(oversized));
});
test('native token bootstrap is limited to the registered extension origin', () => {
  const origin = 'chrome-extension://' + 'a'.repeat(32) + '/';
  const manifest = { allowed_origins: [origin] };
  assert.equal(validOrigin(origin, manifest), true);
  for (const other of ['https://example.com', origin + 'page.html', 'chrome-extension://' + 'b'.repeat(32) + '/', undefined]) assert.equal(validOrigin(other, manifest), false);
});
test('native bootstrap reuses an authenticated bridge without spawning', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fpc-native-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let credential;
  const result = await ensureBridge({ paths: runtimePaths(dir), spawnImpl: () => { throw new Error('unexpected spawn'); }, fetchImpl: async (_url, options) => {
    credential = options.headers.Authorization;
    return Response.json({ app: 'fast-page-chat', version: '0.10.0', protocolVersion: 1 });
  }});
  assert.equal(credential, 'Bearer ' + result.token); assert.match(result.token, /^[a-f0-9]{64}$/); assert.equal(result.ok, true);
});
test('native bootstrap starts a hidden local process with dedicated data after refused connection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fpc-native-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let probes = 0, spawned;
  await ensureBridge({ paths: runtimePaths(dir), launcherExists: () => false, wait: async () => {}, fetchImpl: async () => {
    if (!probes++) throw new TypeError('refused');
    return Response.json({ app: 'fast-page-chat', version: '0.10.0', protocolVersion: 1 });
  }, spawnImpl: (exe, args, options) => {
    spawned = { exe, args, options }; const child = new EventEmitter(); child.unref = () => {}; return child;
  }});
  assert.equal(spawned.options.windowsHide, true); assert.equal(spawned.options.env.FPC_DATA_DIR, dir);
  assert.equal(spawned.options.stdio, 'ignore'); assert.ok(spawned.args[0].endsWith('main.mjs'));
});

test('packaged Windows bootstrap uses the fixed helper to prevent browser pipe inheritance', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fpc-native-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const launcher = join(dir, 'FastPageChatHost.exe');
  let probes = 0, spawned;
  await ensureBridge({ paths: runtimePaths(dir), platform: 'win32', launcherPath: launcher,
    launcherExists: path => path === launcher, wait: async () => {}, fetchImpl: async () => {
      if (!probes++) throw new TypeError('refused');
      return Response.json({ app: 'fast-page-chat', version: '0.10.0', protocolVersion: 1 });
    }, spawnImpl: (exe, args, options) => {
      spawned = { exe, args, options }; const child = new EventEmitter(); child.unref = () => {}; return child;
    }
  });
  assert.equal(spawned.exe, launcher); assert.deepEqual(spawned.args, ['--start-bridge']);
  assert.equal(spawned.options.stdio, 'ignore'); assert.equal(spawned.options.windowsHide, true);
  assert.equal(spawned.options.env.FPC_DATA_DIR, dir);
});

test('a failed Windows startup helper ends bootstrap without waiting for every health probe', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fpc-native-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let probes = 0, child;
  await assert.rejects(ensureBridge({ paths: runtimePaths(dir), platform: 'win32', launcherExists: () => true,
    fetchImpl: async () => { probes++; throw new TypeError('refused'); },
    spawnImpl: () => { child = new EventEmitter(); child.unref = () => {}; return child; },
    wait: async () => { child.emit('exit', 1); }
  }), /起動できません/);
  assert.equal(probes, 1);
});
test('native bootstrap never starts a second bridge on authentication or protocol conflict', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fpc-native-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const response of [new Response('', { status: 401 }), Response.json({ app: 'fast-page-chat', protocolVersion: 99 })]) {
    await assert.rejects(ensureBridge({ paths: runtimePaths(dir), fetchImpl: async () => response, spawnImpl: () => { assert.fail('must not spawn'); } }));
  }
});
