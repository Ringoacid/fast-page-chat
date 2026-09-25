import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { dirname, basename, resolve, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { VERSION, PROTOCOL_VERSION } from '../server/config.mjs';

// Windows-only native messaging integration check. No browser registration,
// account login, model requests, or access to the user's real connection data.
const repository = fileURLToPath(new URL('../', import.meta.url));
const argv = process.argv.slice(2);
const valueFor = flag => { const at = argv.indexOf(flag); return at < 0 ? null : argv[at + 1]; };
const sourceApp = resolve(valueFor('--app') || '');
if (process.platform !== 'win32' || !valueFor('--app')) throw new Error('Usage on Windows: node scripts/native-check.mjs --app <built-package/app>');
const sourceInstaller = resolve(valueFor('--installer') || join(dirname(sourceApp), 'install.ps1'));
const sourceUninstaller = resolve(dirname(sourceInstaller), 'uninstall.ps1');
const verifyBrowser = argv.includes('--browser');
const resultParent = resolve(repository, 'test-results');
await mkdir(resultParent, { recursive: true });
const work = resolve(await mkdtemp(join(resultParent, 'native-check-')));
const stage = resolve(work, 'package'), app = resolve(work, 'installed'), data = resolve(work, 'data');
const report = { startedAt: new Date().toISOString(), status: 'running', version: VERSION, checks: [], scope: 'Compiled Windows launcher, native stdio protocol and isolated local bridge. No registry changes or model requests.' };
if (verifyBrowser) report.scope = 'Compiled Windows launcher and real Chromium Native Messaging in an isolated profile. Only randomly named temporary native-host registry keys; no product registration changes, account login or model requests.';
const check = (condition, message) => { if (!condition) throw new Error(message); };
let token, base, port, phase = 'prepare';
const temporaryRegistryKeys = [];
let browserContext;
function passed(name) { report.checks.push(name); console.log('PASS ' + name); }
function childRun(file, args, { env = process.env, input, timeout = 30000, keepInputOpen = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, cwd: repository, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = []; let size = 0, settled = false, stderrBytes = 0, stderrText = '', exitCode = 'not-exited';
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolveRun(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`${basename(file)} timed out during ${phase} (${size} stdout bytes received, process ${exitCode}).`)); }, timeout);
    child.on('exit', code => { exitCode = String(code); });
    child.on('error', () => finish(new Error(`${basename(file)} could not start during ${phase}.`)));
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 2_000_000) { child.kill(); finish(new Error(`Unexpected output size during ${phase}.`)); }
      else output.push(chunk);
    });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrText.length < 2000) stderrText += chunk.toString('utf8').slice(0, 2000 - stderrText.length); });
    child.on('close', (code, signal) => finish(null, { code, signal, stdout: Buffer.concat(output), stderrBytes, stderrText }));
    if (keepInputOpen) child.stdin.write(input); else child.stdin.end(input);
  });
}
function frame(value) {
  const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
function readFrame(bytes) {
  check(bytes.length >= 4, 'Native host did not return a framed response.');
  const size = bytes.readUInt32LE(0);
  check(size > 0 && size <= 1_000_000 && bytes.length === size + 4, 'Native host returned invalid framing or extra output.');
  try { return JSON.parse(bytes.subarray(4).toString('utf8')); } catch { throw new Error('Native host response was not JSON.'); }
}
async function request(path, { method = 'GET', body, authenticated = true, timeout = 10000 } = {}) {
  return fetch(base + path, {
    method, headers: { ...(authenticated && token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout)
  });
}
async function shutdownOwnBridge() {
  if (!base) return;
  // An interrupted native handshake can still have started the detached bridge.
  if (!token) try { token = (await readFile(resolve(data, 'connection-key.txt'), 'utf8')).trim(); } catch { return; }
  if (!/^[a-f0-9]{64}$/.test(token)) return;
  let health;
  try {
    const response = await request('/health', { timeout: 1500 });
    if (!response.ok) return;
    health = await response.json();
  } catch { return; }
  check(health.app === 'fast-page-chat' && health.protocolVersion === PROTOCOL_VERSION, 'Refusing to stop an unrecognized server.');
  const response = await request('/shutdown', { method: 'POST', body: {}, timeout: 12000 });
  check(response.ok, 'The isolated bridge rejected shutdown.');
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await request('/health', { timeout: 300 }); }
    catch { return; }
    await delay(100);
  }
  throw new Error('The isolated bridge did not exit after authenticated shutdown.');
}
async function removeOwnDirectory(target) {
  const rel = relative(work, resolve(target));
  check(dirname(work) === resultParent && basename(work).startsWith('native-check-') && rel && !rel.startsWith('..') && !isAbsolute(rel), 'Unsafe native-check cleanup path.');
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
try {
  for (const file of [resolve(sourceApp, 'FastPageChatHost.exe'), resolve(sourceApp, 'runtime/node.exe'), resolve(sourceApp, 'runtime/codex.exe'), sourceInstaller, sourceUninstaller]) check((await stat(file)).isFile(), 'The build payload is incomplete.');
  const launcherBytes = await readFile(resolve(sourceApp, 'FastPageChatHost.exe'));
  check(launcherBytes.includes(Buffer.from('runtime-data-path.txt', 'utf16le')) || launcherBytes.includes(Buffer.from('runtime-data-path.txt')), 'Recompile the launcher with isolated runtime-data-path.txt support before this check.');
  const slot = createServer(); slot.listen(0, '127.0.0.1'); await once(slot, 'listening'); port = slot.address().port;
  await new Promise((resolveClose, reject) => slot.close(error => error ? reject(error) : resolveClose()));
  check(port !== 4318, 'The test must never use the normal bridge port.');
  base = `http://127.0.0.1:${port}`; report.port = port;
  await writeFile(resolve(work, 'result.json'), JSON.stringify(report, null, 2));
  const env = { ...process.env, FPC_PORT: String(port), FPC_DATA_DIR: data, OPENAI_API_KEY: '', OPENAI_MODEL: '' };
  for (const key of ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_AUTH_TOKEN', 'CHATGPT_ACCESS_TOKEN']) delete env[key];
  phase = 'duplicate Windows environment fixture';
  const environmentFixture = resolve(work, 'DuplicateEnvironment.exe');
  const compiler = resolve(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const compiled = await childRun(compiler, ['/nologo', '/target:exe', '/optimize+', '/out:' + environmentFixture, resolve(repository, 'test/fixtures/DuplicateEnvironment.cs')], { env });
  check(compiled.code === 0, 'Could not compile the Windows environment regression fixture.');
  const environmentProbe = await childRun(environmentFixture, ['--probe'], { env, timeout: 20000 });
  check(environmentProbe.code === 0, 'The Win32 fixture did not reproduce the .NET Framework PATH/Path dictionary collision.');
  passed('A real inherited Unicode environment block reproduces the Framework PATH/Path collision');
  phase = 'port validation';
  for (const invalidPort of ['0', '65536', '4318oops', '']) {
    const result = await childRun(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1]);', pathToFileURL(resolve(repository, 'server/config.mjs')).href], { env: { ...env, FPC_PORT: invalidPort }, timeout: 5000 });
    check(result.code !== 0, 'The bridge accepted an invalid configured port.');
  }
  passed('Invalid configured ports are rejected before server startup');
  await cp(sourceApp, resolve(stage, 'app'), { recursive: true });
  await cp(sourceInstaller, resolve(stage, 'install.ps1'));
  await cp(sourceUninstaller, resolve(stage, 'uninstall.ps1'));
  // Test the newest implementation against the compiled distribution runtimes.
  await cp(resolve(repository, 'server'), resolve(stage, 'app/server'), { recursive: true });
  await cp(resolve(repository, 'extension'), resolve(stage, 'app/extension'), { recursive: true });
  phase = 'isolated install';
  // A parent PowerShell 7 session can export module paths that Windows
  // PowerShell 5 cannot load; use its normal built-in module discovery.
  const installerEnv = { ...env }; delete installerEnv.PSModulePath;
  const installArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve(repository, 'test/fixtures/InstallWithoutAuditPrivilege.ps1'), '-Installer', resolve(stage, 'install.ps1'), '-InstallRoot', app, '-DataRoot', data];
  const installed = await childRun('powershell.exe', installArgs, { env: installerEnv, timeout: 60000 });
  check(installed.code === 0, 'The isolated NoRegister installation failed: ' + installed.stderrText);
  phase = 'isolated reinstall without audit privilege';
  const reinstalled = await childRun('powershell.exe', installArgs, { env: installerEnv, timeout: 60000 });
  check(reinstalled.code === 0, 'Reinstall into an already protected data directory failed: ' + reinstalled.stderrText);
  passed('Install and reinstall require no audit privilege and preserve private data permissions and ownership');
  check(resolve((await readFile(resolve(app, 'runtime-data-path.txt'), 'utf8')).trim()) === data, 'The installed launcher would use a different data directory.');
  const manifest = JSON.parse(await readFile(resolve(app, 'native-host.json'), 'utf8'));
  const origin = manifest.allowed_origins?.[0];
  check(/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin || ''), 'Installed native manifest has no valid extension origin.');
  check(resolve(manifest.path) === resolve(app, 'FastPageChatHost.exe'), 'Installed native manifest points outside the test installation.');
  passed('NoRegister installation uses isolated application and data directories');
  const launcher = resolve(app, 'FastPageChatHost.exe');
  const bootstrap = async (targetOrigin, duplicateEnvironment = false) => {
    const result = await childRun(duplicateEnvironment ? environmentFixture : launcher, duplicateEnvironment ? [launcher, targetOrigin] : [targetOrigin], { env, input: frame({ type: 'connect' }), timeout: 20000, keepInputOpen: true });
    return { ...result, response: result.stdout.length ? readFrame(result.stdout) : null };
  };
  phase = 'origin validation';
  const foreignOrigin = 'chrome-extension://' + (origin.includes('a'.repeat(32)) ? 'b' : 'a').repeat(32) + '/';
  const denied = await bootstrap(foreignOrigin);
  check(!denied.response?.token && denied.response?.ok !== true, 'Unauthorized extension origin received access.');
  const invalid = await bootstrap('https://example.com/');
  check(invalid.code !== 0 && !invalid.response?.token, 'Invalid native origin was not rejected.');
  passed('Compiled launcher and Node host reject foreign and invalid origins without a token');
  const incomplete = await childRun(launcher, [origin], { env, input: Buffer.alloc(2), timeout: 5000 });
  const incompleteResponse = incomplete.stdout.length ? readFrame(incomplete.stdout) : null;
  check((incomplete.code !== 0 || incompleteResponse?.ok === false) && !incompleteResponse?.token, 'Incomplete native input was not rejected on EOF.');
  passed('Incomplete native input reaches EOF and terminates without starting a bridge');
  phase = 'first native bootstrap';
  const first = await bootstrap(origin, true);
  check(first.code === 0 && first.response?.ok === true, 'Native bootstrap failed.');
  check(first.response.endpoint === base && first.response.protocolVersion === PROTOCOL_VERSION, 'Native bootstrap used the wrong endpoint or protocol.');
  check(/^[a-f0-9]{64}$/.test(first.response.token || ''), 'Native bootstrap did not return a valid connection token.');
  token = first.response.token;
  check((await readFile(resolve(data, 'connection-key.txt'), 'utf8')).trim() === token, 'Native bootstrap used a token outside the isolated data directory.');
  const health = await (await request('/health')).json();
  check(health.app === 'fast-page-chat' && health.version === VERSION && health.protocolVersion === PROTOCOL_VERSION, 'Started bridge metadata does not match this release.');
  check((await request('/health', { authenticated: false })).status === 401, 'Started bridge accepts requests without authentication.');
  passed('Compiled launcher starts the isolated bridge with inherited PATH/Path duplicates');
  passed('Native input left open like Chrome still returns a framed token and reaches launcher stdio EOF while the bridge stays alive');
  phase = 'native reuse';
  const second = await bootstrap(origin);
  check(second.code === 0 && second.response?.ok === true && second.response.token === token && second.response.endpoint === base, 'Repeated native bootstrap did not reuse the connection.');
  passed('A second compiled native bootstrap reuses the authenticated bridge');
  phase = 'fresh Codex diagnostics';
  const diagnostics = await (await request('/diagnostics', { timeout: 40000 })).json();
  check(diagnostics.codex?.state === 'signed_out' && diagnostics.api?.state === 'missing', 'Fresh diagnostics unexpectedly found credentials or failed to start Codex.');
  passed('Bundled Codex starts in a fresh signed-out home without a model request');
  phase = 'protected API settings';
  const sentinel = 'test-native-check-no-real-credential';
  const saved = await request('/settings/api', { method: 'POST', body: { apiKey: sentinel, model: 'test-native-model' } });
  const savedText = await saved.text();
  check(saved.ok && !savedText.includes(sentinel), 'API settings save failed or echoed the credential.');
  const persistedText = await readFile(resolve(data, 'api-settings.json'), 'utf8');
  const persisted = JSON.parse(persistedText);
  check(persisted.keyFormat === 'windows-dpapi' && !persistedText.includes(sentinel), 'Windows API settings were not DPAPI protected.');
  passed('A sentinel API credential is DPAPI protected and never echoed');
  phase = 'bridge shutdown';
  await shutdownOwnBridge();
  passed('Authenticated shutdown stops the isolated bridge and Codex child');
  if (verifyBrowser) {
    phase = 'real browser Native Messaging';
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
    const hostName = 'com.fastpagechat.test_' + randomBytes(8).toString('hex');
    const nativeManifest = resolve(work, 'browser-native-host.json');
    await writeFile(nativeManifest, JSON.stringify({ ...manifest, name: hostName }));
    // Official Chrome and unbranded Chromium use different product roots. The
    // per-run host name is unique, so neither product's existing registration changes.
    for (const browserRoot of ['Google\\Chrome', 'Chromium']) {
      const registryKey = 'HKCU\\Software\\' + browserRoot + '\\NativeMessagingHosts\\' + hostName;
      const exists = await childRun('reg.exe', ['query', registryKey]);
      check(exists.code !== 0, 'Refusing to replace an existing native-host registration.');
      const registered = await childRun('reg.exe', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', nativeManifest, '/f']);
      check(registered.code === 0, 'Could not create the isolated native-host test registration.');
      temporaryRegistryKeys.push(registryKey);
    }
    const extension = resolve(work, 'browser-extension');
    await mkdir(extension);
    const identity = JSON.parse(await readFile(resolve(app, 'installer/extension-identity.json'), 'utf8'));
    await writeFile(resolve(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Fast Page Chat native integration fixture', version: '1.0.0', key: identity.key, permissions: ['nativeMessaging'], host_permissions: ['http://127.0.0.1/*'], background: { service_worker: 'background.js' } }));
    await writeFile(resolve(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
    browserContext = await chromium.launchPersistentContext(resolve(work, 'browser-profile'), {
      headless: true, channel: 'chromium', executablePath: process.env.CHROMIUM_BIN || undefined, env,
      args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension], timeout: 30000
    });
    let worker = browserContext.serviceWorkers()[0];
    if (!worker) worker = await browserContext.waitForEvent('serviceworker', { timeout: 15000 });
    check('chrome-extension://' + new URL(worker.url()).host + '/' === origin, 'The browser test extension has the wrong identity.');
    await worker.evaluate(({ hostName, base }) => {
      globalThis.nativeCheck = { state: 'waiting_native_callback' };
      chrome.runtime.sendNativeMessage(hostName, { type: 'connect' }, async response => {
        const error = chrome.runtime.lastError;
        if (error) { globalThis.nativeCheck = { state: 'error', message: error.message }; return; }
        if (!response?.ok || response.endpoint !== base || !/^[a-f0-9]{64}$/.test(response.token || '')) { globalThis.nativeCheck = { state: 'invalid_native_response' }; return; }
        globalThis.nativeCheck = { state: 'fetching_health' };
        try {
          const health = await (await fetch(base + '/health', { headers: { Authorization: 'Bearer ' + response.token }, signal: AbortSignal.timeout(5000) })).json();
          globalThis.nativeCheck = { state: 'done', ok: true, app: health.app, version: health.version, protocolVersion: health.protocolVersion };
        } catch (error) { globalThis.nativeCheck = { state: 'error', message: error.message }; }
      });
    }, { hostName, base });
    let native;
    for (let attempt = 0; attempt < 100; attempt++) {
      native = await worker.evaluate(() => globalThis.nativeCheck);
      if (!['waiting_native_callback', 'fetching_health'].includes(native?.state)) break;
      await delay(200);
    }
    report.browserState = native;
    check(!['waiting_native_callback', 'fetching_health'].includes(native?.state), 'Real browser Native Messaging timed out at ' + native?.state);
    check(native.ok && native.app === 'fast-page-chat' && native.version === VERSION && native.protocolVersion === PROTOCOL_VERSION, 'Real browser Native Messaging did not authenticate the bridge.');
    passed('Real Chromium sendNativeMessage starts and authenticates the compiled native bridge');
    await shutdownOwnBridge();
    await browserContext.close(); browserContext = null;
  }
  phase = 'restart with saved settings';
  const restarted = await bootstrap(origin);
  check(restarted.code === 0 && restarted.response?.ok === true && restarted.response.token === token, 'Native bootstrap did not restart with the existing isolated token.');
  const restored = await (await request('/health')).json();
  check(restored.apiConfigured === true && restored.apiModel === 'test-native-model', 'Saved API settings were not restored after restart.');
  check((await request('/settings/api', { method: 'POST', body: { apiKey: '', model: '' } })).ok, 'Could not clear the sentinel API credential.');
  passed('Native restart restores saved settings; the sentinel credential can be cleared');
  await shutdownOwnBridge();
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.phase = phase; report.error = error.message; process.exitCode = 1;
} finally {
  try { await shutdownOwnBridge(); }
  catch (error) { report.status = 'failed'; report.cleanupError = error.message; process.exitCode = 1; }
  try { await browserContext?.close(); } catch { report.browserCleanupFailed = true; }
  for (const registryKey of temporaryRegistryKeys.reverse()) {
    const removed = await childRun('reg.exe', ['delete', registryKey, '/f']);
    if (removed.code !== 0) { report.status = 'failed'; report.registryCleanupError = registryKey; process.exitCode = 1; }
  }
  if (temporaryRegistryKeys.length && !report.registryCleanupError) report.temporaryRegistryKeysRemoved = true;
  if (report.status === 'passed') {
    for (const directory of [stage, app, data, ...(verifyBrowser ? [resolve(work, 'browser-profile'), resolve(work, 'browser-extension')] : [])]) await removeOwnDirectory(directory);
    report.temporaryInstallationRemoved = true;
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(work, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, phase: report.phase, error: report.error, cleanupError: report.cleanupError, report: resolve(work, 'result.json') }));
}
