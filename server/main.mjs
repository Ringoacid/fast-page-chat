import { createBridge } from './http.mjs';
import { CodexClient } from './codex.mjs';
import { apiAnswer } from './api.mjs';
import { runtimePaths, loadConnectionToken, loadApiSettings, BRIDGE_PORT } from './config.mjs';
import { clearCodexDiagnostics } from './diagnostics.mjs';

const paths = runtimePaths();
const token = await loadConnectionToken(paths);
const settings = await loadApiSettings(paths);
const codex = new CodexClient({ paths });
const server = createBridge({
  token, codex, apiSettings: settings,
  apiAnswer: (request, emit, signal) => { const { apiKey, model } = settings.get(); return apiAnswer(request, emit, signal, { apiKey, defaultModel: model }); },
  clearLogs: () => clearCodexDiagnostics(paths),
  shutdown: () => { server.close(); server.closeAllConnections(); }
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `ポート${BRIDGE_PORT}は使用中です。既存の接続サーバーを確認してください。` : error.message); codex.close(); process.exitCode = 1; });
server.listen(BRIDGE_PORT, '127.0.0.1', () => {
  console.log(`Fast Page Chat: http://127.0.0.1:${BRIDGE_PORT}`);
  console.log(`接続キーのファイル: ${paths.tokenPath}`);
  console.log('ファイル内のキーを拡張機能の「接続設定」に貼り付けてください。');
});
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => { codex.close(); server.close(); server.closeAllConnections(); });
