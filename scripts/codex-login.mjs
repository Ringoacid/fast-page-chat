import { spawn } from 'node:child_process';
import { codexBin, codexHome, codexCwd, prepareCodex } from '../server/codex.mjs';
await prepareCodex();
console.log('Fast Page Chat専用のCodexにログインします。普段のCodex設定は変更しません。');
const child = spawn(codexBin(), ['login'], { cwd: codexCwd, env: { ...process.env, CODEX_HOME: codexHome }, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
