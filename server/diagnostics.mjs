import { lstat, realpath, unlink } from 'node:fs/promises';
import { relative, resolve, isAbsolute, dirname } from 'node:path';
import { runtimePaths } from './config.mjs';

// Deliberately no wildcards or recursive deletion. Auth, state, settings, cache,
// unknown future files and other Codex installations are not deletion targets.
export const DIAGNOSTIC_FILES = [
  'logs_1.sqlite', 'logs_1.sqlite-wal', 'logs_1.sqlite-shm', 'logs_1.sqlite-journal',
  'logs_2.sqlite', 'logs_2.sqlite-wal', 'logs_2.sqlite-shm', 'logs_2.sqlite-journal',
  'log/codex-tui.log', 'log/codex-login.log', 'log/codex-app-server.log'
];
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const within = (parent, child) => { const path = relative(parent, child); return path && !path.startsWith('..') && !isAbsolute(path); };

export async function clearCodexDiagnostics(paths = runtimePaths()) {
  const home = resolve(paths.codexHome), expectedHome = resolve(paths.dataDir, 'codex-home');
  if (!samePath(home, expectedHome)) throw new Error('診断ログの保存先が不正です。');
  let actualHome;
  try {
    // A Windows 8.3 path (for example RUNNER~1) legitimately resolves to a
    // different spelling. Detect links explicitly in every ancestor instead of
    // treating any realpath spelling change as a redirect.
    for (let directory = home; ; directory = dirname(directory)) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('診断ログの保存先がリンクになっています。');
      if (dirname(directory) === directory) break;
    }
    actualHome = await realpath(home);
  } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  const targets = [];
  // Validate all candidates before deleting the first file.
  for (const name of DIAGNOSTIC_FILES) {
    const target = resolve(actualHome, name);
    if (!within(actualHome, target)) throw new Error('診断ログの保存先が不正です。');
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || !samePath(await realpath(target), target)) throw new Error('診断ログに通常のファイル以外が含まれています。');
      targets.push(target);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let count = 0;
  for (const target of targets) { await unlink(target); count++; }
  return count;
}
