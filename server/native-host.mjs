import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { VERSION, PROTOCOL_VERSION, BRIDGE_PORT, runtimePaths, loadConnectionToken } from './config.mjs';

export const ENDPOINT = 'http://127.0.0.1:' + BRIDGE_PORT;
export function encodeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > 1_000_000) throw new Error('Native response is too large.');
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
export function decodeMessage(buffer) {
  if (buffer.length < 4) return null;
  const size = buffer.readUInt32LE(0);
  if (!size || size > 4096) throw new Error('Invalid native message size.');
  if (buffer.length < size + 4) return null;
  if (buffer.length !== size + 4) throw new Error('Only one request is supported.');
  const request = JSON.parse(buffer.subarray(4).toString('utf8'));
  if (request?.type !== 'connect' || Object.keys(request).length !== 1) throw new Error('Unsupported native request.');
  return request;
}
export function validOrigin(origin, manifest) {
  return /^chrome-extension:\/\/[a-p]{32}\/$/.test(origin || '') && manifest?.allowed_origins?.includes(origin);
}
export async function ensureBridge({ paths = runtimePaths(), fetchImpl = fetch, spawnImpl = spawn, wait = delay,
  platform = process.platform, launcherPath = fileURLToPath(new URL('../FastPageChatHost.exe', import.meta.url)), launcherExists = existsSync } = {}) {
  const token = await loadConnectionToken(paths);
  async function probe() {
    let response;
    try { response = await fetchImpl(ENDPOINT + '/health', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(1500) }); }
    catch { return null; }
    if (!response.ok) throw new Error('別の接続サーバーがポート4318を使用しています。以前のFast Page Chatサーバーを終了してから接続してください。');
    const health = await response.json();
    if (health.app !== 'fast-page-chat' || health.protocolVersion !== PROTOCOL_VERSION) throw new Error('接続サーバーの更新が必要です。補助アプリを更新し、以前のサーバーを終了してください。');
    return health;
  }
  let health = await probe();
  if (!health) {
    // The Windows helper uses CreateProcessW with bInheritHandles=false. A plain
    // detached Node spawn can keep Chrome's native-message pipes open in the
    // long-lived server, preventing sendNativeMessage from completing.
    const nativeLaunch = platform === 'win32' && launcherExists(launcherPath);
    const child = spawnImpl(nativeLaunch ? launcherPath : process.execPath, nativeLaunch ? ['--start-bridge'] : [fileURLToPath(new URL('./main.mjs', import.meta.url))], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, FPC_DATA_DIR: paths.dataDir },
      stdio: 'ignore', windowsHide: true, detached: true
    });
    let failed = false;
    child.on('error', () => { failed = true; });
    if (nativeLaunch) child.on('exit', code => { if (code !== 0) failed = true; });
    child.unref();
    for (let attempt = 0; attempt < 40; attempt++) {
      await wait(200);
      if (failed) break;
      health = await probe();
      if (health) break;
    }
    if (!health) throw new Error('補助アプリを起動できませんでした。再インストールしてから接続してください。');
  }
  return { ok: true, token, endpoint: ENDPOINT, version: health.version || VERSION, protocolVersion: health.protocolVersion };
}
export async function runNativeHost(origin) {
  // Both Chrome's registration and this check restrict bootstrap to our extension.
  const manifest = JSON.parse(await readFile(new URL('../native-host.json', import.meta.url), 'utf8'));
  if (!validOrigin(origin, manifest)) throw new Error('This extension is not authorized.');
  let input = Buffer.alloc(0), received = false;
  await new Promise((resolve, reject) => {
    process.stdin.on('data', chunk => {
      if (received) return;
      try {
        input = Buffer.concat([input, chunk]);
        if (input.length > 4100) throw new Error('Invalid native message size.');
        if (!decodeMessage(input)) return;
        received = true; process.stdin.pause();
        ensureBridge().then(result => process.stdout.write(encodeMessage(result), error => error ? reject(error) : resolve())).catch(reject);
      } catch (error) { received = true; reject(error); }
    });
    process.stdin.on('end', () => { if (!received) reject(new Error('Incomplete native message.')); });
    process.stdin.on('error', reject);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runNativeHost(process.argv[2]); }
  catch (error) { await new Promise(resolve => process.stdout.write(encodeMessage({ ok: false, error: error.message }), resolve)); }
  process.stdin.destroy();
}
