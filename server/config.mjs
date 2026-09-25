import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export const VERSION = '0.10.0';
export const PROTOCOL_VERSION = 1;
const port = process.env.FPC_PORT;
if (port !== undefined && (!/^\d+$/.test(port) || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535)) throw new Error('FPC_PORTは1〜65535の整数で指定してください。');
export const BRIDGE_PORT = port === undefined ? 4318 : Number(port);
const defaultDataDir = fileURLToPath(new URL('../.local/', import.meta.url));

export function runtimePaths(dataDir = process.env.FPC_DATA_DIR) {
  dataDir = resolve(dataDir || defaultDataDir);
  return {
    dataDir, tokenPath: resolve(dataDir, 'connection-key.txt'), apiConfigPath: resolve(dataDir, 'api-settings.json'),
    codexHome: resolve(dataDir, 'codex-home'), codexCwd: resolve(dataDir, 'empty-workspace')
  };
}
export async function prepareRuntime(paths = runtimePaths()) {
  for (const path of [paths.dataDir, paths.codexHome, paths.codexCwd]) await mkdir(path, { recursive: true, mode: 0o700 });
  return paths;
}
export async function loadConnectionToken(paths = runtimePaths()) {
  await prepareRuntime(paths);
  let token;
  try { token = (await readFile(paths.tokenPath, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    token = randomBytes(32).toString('hex');
    try { await writeFile(paths.tokenPath, token, { mode: 0o600, flag: 'wx' }); }
    catch (writeError) {
      // Two native-host connections can start at the same time.
      if (writeError.code !== 'EEXIST') throw writeError;
      token = (await readFile(paths.tokenPath, 'utf8')).trim();
    }
  }
  // An exclusive creator may have opened the file but not finished its write.
  for (let attempt = 0; token === '' && attempt < 20; attempt++) { await delay(10); token = (await readFile(paths.tokenPath, 'utf8')).trim(); }
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('接続キーが破損しています。接続アプリを再設定してください。');
  return token;
}

// Windows DPAPI protects API credentials for the current Windows account. Secrets
// go through stdin/stdout, never command-line arguments or diagnostic output.
function dpapi(value, decrypt = false) {
  const transform = decrypt
    ? '[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($value),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))'
    : '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($value),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))';
  const script = '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Security; $value=[Console]::In.ReadToEnd(); [Console]::Out.Write(' + transform + ')';
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env }; delete env.PSModulePath;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', finished = false;
    const finish = error => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolvePromise(output); };
    const failure = () => new Error('APIキーをWindowsの保護ストレージへ保存・読み込みできませんでした。');
    const timer = setTimeout(() => { child.kill(); finish(failure()); }, 15000);
    child.stdout.on('data', data => { output += data.toString('utf8'); if (output.length > 32000) { child.kill(); finish(failure()); } });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(failure()));
    child.stdin.on('error', () => finish(failure()));
    child.on('close', code => finish(code === 0 ? null : failure()));
    child.stdin.end(value);
  });
}
export function platformSecretStore(platform = process.platform) {
  return platform === 'win32'
    ? { format: 'windows-dpapi', protect: value => dpapi(value), unprotect: value => dpapi(value, true) }
    : { format: 'private-file', protect: async value => value, unprotect: async value => value };
}
function validSettings(value, existing) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('API設定が不正です。');
  const apiKey = value.apiKey === undefined ? existing.apiKey : value.apiKey;
  const model = value.model === undefined ? existing.model : value.model;
  if (typeof apiKey !== 'string' || apiKey.length > 8192 || (apiKey && !/^[\x21-\x7e]+$/.test(apiKey))) throw new Error('APIキーが不正です。');
  if (typeof model !== 'string' || model.length > 150 || (model && !/^[\w.:-]+$/.test(model))) throw new Error('モデルIDが不正です。');
  return { apiKey, model };
}
export async function loadApiSettings(paths = runtimePaths(), { env = process.env, secretStore = platformSecretStore() } = {}) {
  await prepareRuntime(paths);
  let current = { apiKey: env.OPENAI_API_KEY || '', model: env.OPENAI_MODEL || '' };
  try {
    const saved = JSON.parse(await readFile(paths.apiConfigPath, 'utf8'));
    if (saved.version !== 1 || saved.keyFormat !== secretStore.format || typeof saved.protectedKey !== 'string') throw new Error('invalid');
    current = validSettings({ apiKey: saved.protectedKey ? await secretStore.unprotect(saved.protectedKey) : '', model: saved.model }, current);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('保存したAPI設定を読み込めません。設定ファイルを確認してください。');
  }
  let queue = Promise.resolve();
  return {
    get: () => ({ ...current }),
    save(value) {
      const task = queue.then(async () => {
        const next = validSettings(value, current);
        const protectedKey = next.apiKey ? await secretStore.protect(next.apiKey) : '';
        const temporary = paths.apiConfigPath + '.' + randomBytes(8).toString('hex') + '.tmp';
        try {
          await writeFile(temporary, JSON.stringify({ version: 1, keyFormat: secretStore.format, protectedKey, model: next.model }), { mode: 0o600, flag: 'wx' });
          await rename(temporary, paths.apiConfigPath);
        } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
        current = next;
        return { apiConfigured: Boolean(current.apiKey), apiModel: current.model };
      });
      queue = task.catch(() => {});
      return task;
    }
  };
}
