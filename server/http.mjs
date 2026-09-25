import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { validateRequest } from './prompt.mjs';
import { validateTitleRequest, cleanTitle } from './title.mjs';
import { VERSION, PROTOCOL_VERSION } from './config.mjs';

const MAX_REQUEST_BYTES = 70_000_000;

export function createBridge({ token, codex, apiAnswer, apiConfigured = false, apiModel = '', apiSettings, clearLogs, shutdown }) {
  let active = 0;
  let receiving = 0;
  let controls = 0;
  let maintenance = false;
  const version = { app: 'fast-page-chat', version: VERSION, protocolVersion: PROTOCOL_VERSION };
  const apiStatus = () => apiSettings ? { apiConfigured: Boolean(apiSettings.get().apiKey), apiModel: apiSettings.get().model } : { apiConfigured, apiModel };
  return createServer(async (req, res) => {
    const host = req.headers.host;
    const origin = req.headers.origin;
    const trustedOrigin = !origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
    if (!/^127\.0\.0\.1:\d+$/.test(host || '') || !trustedOrigin) { res.writeHead(403); res.end('Forbidden'); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type' }); res.end(); return;
    }
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401); res.end('接続キーが違います。'); return; }
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && req.url === '/health') { json(200, { ok: true, ...version, ...apiStatus() }); return; }
    if (maintenance) { json(409, { error: '接続アプリを更新中です。少し待って再接続してください。' }); return; }
    if (req.method === 'GET' && ['/diagnostics', '/login/status'].includes(req.url)) {
      if (controls >= 4) { json(429, { error: '接続確認中です。少し待って再試行してください。' }); return; }
      controls++;
      try {
        if (req.url === '/login/status') json(200, await codex.loginStatus());
        else {
          const codexStatus = await codex.diagnostics();
          const configured = apiStatus().apiConfigured;
          json(200, { ...version, codex: codexStatus, api: { state: configured ? 'configured' : 'missing', message: configured ? 'APIキーを設定済みです。キーの有効性や残高は未確認です。' : 'APIキーを設定してください。' } });
        }
      } catch { json(503, { state: 'error', error: '接続状態を確認できませんでした。', message: '接続アプリを再起動してお試しください。' }); }
      finally { controls--; }
      return;
    }
    if (req.method === 'POST' && ['/login/start', '/settings/api', '/logs/clear', '/shutdown'].includes(req.url)) {
      const exclusive = ['/logs/clear', '/shutdown'].includes(req.url);
      if (exclusive && (active || receiving || controls || codex.login?.state === 'pending')) { json(409, { error: '回答・接続確認・ログインが完了してからお試しください。' }); return; }
      if (controls >= 4) { json(429, { error: '設定を更新中です。少し待って再試行してください。' }); return; }
      if (!req.headers['content-type']?.startsWith('application/json')) { json(415, { error: 'JSONのみ受け付けます。' }); return; }
      // Lock before reading an exclusive request body: no new model/control work
      // may start between checking counters and stopping the child process.
      if (exclusive) maintenance = true;
      controls++;
      try {
        let size = 0; const chunks = [];
        if (Number(req.headers['content-length']) > 16000) { json(413, { error: '設定が大きすぎます。' }); return; }
        for await (const chunk of req) { size += chunk.length; if (size > 16000) { json(413, { error: '設定が大きすぎます。' }); return; } chunks.push(chunk); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
        catch { json(400, { error: 'JSONが不正です。' }); return; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) { json(400, { error: '設定が不正です。' }); return; }
        if (req.url === '/login/start') json(200, await codex.startLogin());
        if (req.url === '/settings/api') {
          if (!apiSettings) { json(503, { error: 'API設定の保存に対応していません。' }); return; }
          try { json(200, { ok: true, ...await apiSettings.save(body) }); }
          catch { json(400, { error: 'API設定を保存できませんでした。キー・モデルIDと保存先を確認してください。' }); }
        }
        if (req.url === '/logs/clear') {
          if (!clearLogs) { json(503, { error: '診断ログの削除に対応していません。' }); return; }
          await codex.stop();
          json(200, { ok: true, count: await clearLogs() });
        }
        if (req.url === '/shutdown') {
          if (!shutdown) { json(503, { error: '接続アプリの終了に対応していません。' }); return; }
          await codex.stop();
          res.once('finish', shutdown);
          json(200, { ok: true });
        }
      } catch { json(503, { error: '操作を完了できませんでした。接続アプリを確認して再試行してください。' }); }
      finally { controls--; if (exclusive) maintenance = false; }
      return;
    }
    if (req.method === 'GET' && req.url === '/models') {
      if (controls >= 4) { json(429, { error: 'モデル一覧を取得中です。' }); return; }
      controls++;
      try { json(200, { models: await codex.models() }); } catch (error) { json(503, { error: error.message }); }
      finally { controls--; }
      return;
    }
    const titleRequest = req.method === 'POST' && req.url === '/title';
    if (req.method !== 'POST' || (!titleRequest && req.url !== '/chat')) { json(404, { error: 'Not found' }); return; }
    if (!req.headers['content-type']?.startsWith('application/json')) { json(415, { error: 'JSONのみ受け付けます。' }); return; }
    if (active + receiving >= 4) { json(429, { error: '実行中の回答が多すぎます。完了後に再試行してください。' }); return; }
    if (Number(req.headers['content-length']) > MAX_REQUEST_BYTES) { json(413, { error: '送信内容が大きすぎます。' }); return; }
    let request;
    receiving++;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) { json(413, { error: '送信内容が大きすぎます。' }); return; }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      request = titleRequest ? validateTitleRequest(body) : validateRequest(body);
    } catch (error) { json(400, { error: error.message }); return; }
    finally { receiving--; }
    // Recheck after reading the body: several uploads can finish concurrently.
    if (active >= 4) { json(429, { error: '実行中の回答が多すぎます。完了後に再試行してください。' }); return; }
    active++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(titleRequest ? 'タイトル生成が完了しませんでした。' : '回答が5分以内に完了しませんでした。')), titleRequest ? 60000 : 300000);
    const disconnected = () => controller.abort(new Error('接続が閉じられました。'));
    res.on('close', disconnected);
    if (titleRequest) {
      try {
        let output = '';
        const collect = event => {
          if (event.type === 'delta') output += event.text;
          if (output.length > 1000) {
            const error = new Error('生成されたタイトルが長すぎます。');
            controller.abort(error);
            throw error;
          }
        };
        if (request.provider === 'codex') await codex.answer(request, collect, controller.signal);
        else await apiAnswer(request, collect, controller.signal);
        controller.signal.throwIfAborted();
        const title = cleanTitle(output);
        if (!title) throw new Error('タイトルを生成できませんでした。');
        json(200, { title });
      } catch (error) { if (!res.destroyed) json(502, { error: (controller.signal.aborted ? controller.signal.reason : error).message }); }
      finally { active--; clearTimeout(timeout); res.off('close', disconnected); }
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
    res.flushHeaders();
    const emit = event => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000);
    const started = performance.now(); let firstText = null;
    const forward = event => { if (event.type === 'delta' && firstText === null) firstText = Math.round(performance.now() - started); emit(event); };
    try {
      emit({ type: 'status', text: request.provider === 'codex' ? 'Codexで回答を生成中…' : 'APIで回答を生成中…' });
      if (request.provider === 'codex') await codex.answer(request, forward, controller.signal);
      else await apiAnswer(request, forward, controller.signal);
      emit({ type: 'done', firstTextMs: firstText, totalMs: Math.round(performance.now() - started) });
    } catch (error) { emit({ type: 'error', message: error.message }); }
    finally { active--; clearTimeout(timeout); clearInterval(heartbeat); res.off('close', disconnected); res.end(); }
  });
}
