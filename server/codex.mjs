import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { INSTRUCTIONS, codexInput } from './prompt.mjs';
import { runtimePaths, prepareRuntime, VERSION } from './config.mjs';

export const { codexHome, codexCwd } = runtimePaths();
export const codexBin = () => process.env.CODEX_BIN || 'codex';
export async function prepareCodex(paths = runtimePaths()) { await prepareRuntime(paths); }

// These settings reduce persistence/export but do not promise that every Codex
// version omits diagnostic SQLite logs. The settings UI provides explicit cleanup.
export const CODEX_CONFIG = {
  web_search: 'disabled', 'features.shell_tool': false, 'features.unified_exec': false,
  'tools.view_image': false, 'agents.enabled': false, project_doc_max_bytes: 0,
  'history.persistence': 'none', 'analytics.enabled': false, 'feedback.enabled': false,
  'otel.log_user_prompt': false, 'otel.exporter': 'none', 'otel.trace_exporter': 'none', 'otel.metrics_exporter': 'none'
};

// One warm process; every request gets an ephemeral conversation, so tabs cannot leak context.
export class CodexClient extends EventEmitter {
  constructor({ paths = runtimePaths(), spawnImpl = spawn } = {}) {
    super(); this.paths = paths; this.spawnImpl = spawnImpl; this.pending = new Map(); this.nextId = 1;
    this.child = null; this.ready = null; this.stopping = null; this.login = null; this.loginRequest = null;
  }
  async start() {
    if (this.stopping) await this.stopping;
    if (this.ready) return this.ready;
    this.ready = this.connect().catch(error => { this.close(); throw error; });
    return this.ready;
  }
  async connect() {
    await prepareCodex(this.paths);
    const args = ['app-server', '--listen', 'stdio://', ...Object.entries(CODEX_CONFIG).flatMap(([key, value]) => ['-c', key + '=' + JSON.stringify(value)])];
    const env = { ...process.env, CODEX_HOME: this.paths.codexHome, CODEX_SQLITE_HOME: this.paths.codexHome, RUST_LOG: 'off' };
    // Do not let inherited debug recording/export variables create additional copies.
    for (const key of ['OPENAI_API_KEY', 'OPENAI_MODEL', 'CODEX_ROLLOUT_TRACE_ROOT', 'CODEX_TUI_RECORD_SESSION', 'CODEX_TUI_SESSION_LOG_PATH', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS']) delete env[key];
    const child = this.spawnImpl(codexBin(), args, {
      cwd: this.paths.codexCwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    // Do not log page text, tokens, or entire server messages.
    child.stderr.on('data', () => {});
    child.stdin.on('error', error => this.fail(error));
    child.on('error', error => { const failure = new Error('Codexを起動できません。接続アプリを再インストールするか、CODEX_BIN を確認してください。'); failure.code = error.code; this.fail(failure); });
    child.on('exit', () => {
      if (this.child === child) { this.child = null; this.ready = null; this.fail(new Error('Codex App Serverが終了しました。')); }
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id != null) {
        // No interactive approvals or client-side tools are supported by this reading-only client.
        this.send({ id: message.id, error: { code: -32601, message: 'This client does not provide tools or approvals.' } });
      } else if (message.id != null) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      } else if (message.method) {
        if (message.method === 'account/login/completed') {
          this.lastLoginResult = message.params;
          if (message.params?.loginId === this.login?.loginId) this.applyLoginResult(message.params);
        }
        this.emit('notification', message);
      }
    });
    await this.call('initialize', { clientInfo: { name: 'fast_page_chat', title: 'Fast Page Chat', version: VERSION } });
    this.send({ method: 'initialized', params: {} });
  }
  send(message) { if (!this.child?.stdin.writable) throw new Error('Codexへの接続がありません。'); this.child.stdin.write(JSON.stringify(message) + '\n'); }
  call(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method}: タイムアウトしました。`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  fail(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emit('failure', error);
  }
  close() {
    const child = this.child; this.child = null; this.ready = null;
    if (this.login?.state === 'pending') this.login = { ...this.login, state: 'error', message: '接続が終了しました。もう一度ログインしてください。' };
    this.fail(new Error('Codexへの接続を閉じました。'));
    if (!child || child.exitCode !== null || child.signalCode != null) return this.stopping || Promise.resolve();
    const stopped = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Codexの停止を確認できませんでした。ログは削除していません。')), 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
    this.stopping = stopped;
    stopped.then(() => { if (this.stopping === stopped) this.stopping = null; }, () => {});
    return stopped;
  }
  async stop() { await this.close(); }
  async models() { await this.start(); const result = await this.call('model/list', {}); return result.data; }
  async diagnostics() {
    try {
      await this.start();
      const { account } = await this.call('account/read', { refreshToken: false });
      if (!account) return { state: 'signed_out', message: 'ChatGPTアカウントでログインしてください。' };
      const models = await this.models();
      return { state: 'ready', message: 'Codexにログイン済みです。モデル一覧を取得しました。', models };
    } catch (error) {
      return { state: ['ENOENT', 'EACCES'].includes(error.code) ? 'unavailable' : 'error', message: 'Codexへ接続できません。接続アプリとログイン状態を確認してください。' };
    }
  }
  async startLogin() {
    if (this.loginRequest) return this.loginRequest;
    if (this.login?.state === 'pending' && Date.now() - this.login.startedAt < 10 * 60 * 1000) return { authUrl: this.login.authUrl, loginId: this.login.loginId };
    const task = (async () => {
      await this.start();
      const result = await this.call('account/login/start', { type: 'chatgpt' });
      let url;
      try { url = new URL(result.authUrl); } catch { throw new Error('ログインURLを取得できませんでした。'); }
      if (result.type !== 'chatgpt' || typeof result.loginId !== 'string' || url.protocol !== 'https:' || !['auth.openai.com', 'auth0.openai.com', 'platform.openai.com', 'chatgpt.com', 'auth.chatgpt.com'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('ログインURLを確認できませんでした。');
      this.login = { state: 'pending', message: 'ブラウザでログインを完了してください。', authUrl: result.authUrl, loginId: result.loginId, startedAt: Date.now() };
      if (this.lastLoginResult?.loginId === result.loginId) this.applyLoginResult(this.lastLoginResult);
      return { authUrl: result.authUrl, loginId: result.loginId };
    })();
    this.loginRequest = task;
    try { return await task; } finally { if (this.loginRequest === task) this.loginRequest = null; }
  }
  applyLoginResult(result) {
    this.login.state = result.success ? 'ready' : 'error';
    this.login.message = result.success ? 'Codexにログインしました。' : 'ログインを完了できませんでした。もう一度お試しください。';
  }
  async loginStatus() {
    await this.start();
    const { account } = await this.call('account/read', { refreshToken: false });
    if (account) {
      if (this.login) this.login = { ...this.login, state: 'ready', message: 'Codexにログインしました。' };
      return { state: 'ready', message: 'Codexにログインしました。', ...(this.login?.loginId ? { loginId: this.login.loginId } : {}) };
    }
    if (this.login?.state === 'pending' && Date.now() - this.login.startedAt >= 10 * 60 * 1000) this.login = { ...this.login, state: 'error', message: 'ログインの待機時間を過ぎました。もう一度お試しください。' };
    return this.login ? { state: this.login.state === 'ready' ? 'signed_out' : this.login.state, message: this.login.state === 'ready' ? 'ChatGPTアカウントでログインしてください。' : this.login.message, loginId: this.login.loginId } : { state: 'signed_out', message: 'ChatGPTアカウントでログインしてください。' };
  }
  async answer(request, emit, signal) {
    await this.start(); signal.throwIfAborted();
    const account = await this.call('account/read', { refreshToken: false });
    if (!account.account) throw new Error('この拡張機能用のCodexに未ログインです。接続設定の「ChatGPTでログイン」を押してください。');
    const models = await this.models();
    const model = request.model ? models.find(m => m.model === request.model || m.id === request.model) : models.find(m => m.isDefault) || models[0];
    if (!model) throw new Error('利用できるCodexモデルが見つかりません。設定のモデルIDを確認してください。');
    const efforts = model.supportedReasoningEfforts?.map(e => e.reasoningEffort) || [];
    if (request.effort && !efforts.includes(request.effort)) throw new Error('このモデルは選択したエフォートに対応していません。モデル一覧を更新して選び直してください。');
    if (request.images?.length && model.inputModalities && !model.inputModalities.includes('image')) throw new Error('このモデルは画像入力に対応していません。モデルを変更するか画像をオフにしてください。');
    const effort = request.effort || ['none', 'minimal', 'low'].find(e => efforts.includes(e)) || model.defaultReasoningEffort;
    const { thread } = await this.call('thread/start', {
      model: model.model, cwd: this.paths.codexCwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
      baseInstructions: request.instructions || INSTRUCTIONS, developerInstructions: request.instructions || INSTRUCTIONS,
      config: { ...CODEX_CONFIG }
    });
    let turnId;
    try {
      signal.throwIfAborted();
      await new Promise((resolve, reject) => {
        const pieces = new Map();
        let settled = false, stopped = false, interruptedTurnId;
        const interrupt = () => {
          stopped = true;
          if (!turnId || interruptedTurnId === turnId) return;
          interruptedTurnId = turnId;
          this.call('turn/interrupt', { threadId: thread.id, turnId }).catch(() => {});
        };
        const finish = error => {
          if (settled) return;
          settled = true;
          this.off('notification', onMessage); this.off('failure', finish); signal.removeEventListener('abort', abort);
          error ? reject(error) : resolve();
        };
        const stop = error => {
          if (settled) return;
          interrupt(); finish(error);
        };
        const abort = () => stop(signal.reason || new Error('停止しました。'));
        const onMessage = ({ method, params: p }) => {
          if (settled || p?.threadId !== thread.id) return;
          // Notifications run outside this Promise's executor. Consumer errors
          // must reject this answer, never escape the EventEmitter and crash Node.
          try {
            if (method === 'turn/started') turnId = p.turn.id;
            if (method === 'item/agentMessage/delta') { pieces.set(p.itemId, true); emit({ type: 'delta', text: p.delta }); }
            if (method === 'item/completed' && p.item?.type === 'agentMessage' && !pieces.has(p.item.id)) emit({ type: 'delta', text: p.item.text });
            if (method === 'turn/completed') finish(p.turn.status === 'completed' ? null : new Error(p.turn.error?.message || 'Codexの回答が中断されました。'));
            if (method === 'error' && !p.willRetry) finish(new Error(p.error?.message || 'Codexでエラーが発生しました。'));
          } catch (error) { stop(error); }
        };
        this.on('notification', onMessage); this.on('failure', finish); signal.addEventListener('abort', abort, { once: true });
        this.call('turn/start', { threadId: thread.id, input: codexInput(request), effort }).then(result => {
          turnId = result.turn.id;
          // Cancellation or a consumer error can precede the start response.
          if (stopped || signal.aborted) interrupt();
        }).catch(finish);
      });
    } finally { await this.call('thread/unsubscribe', { threadId: thread.id }).catch(() => {}); }
  }
}
