import { INSTRUCTIONS, apiInput } from './prompt.mjs';
import { readSSE } from '../extension/stream.js';

export async function listApiModels(apiKey, { fetchImpl = fetch, signal = AbortSignal.timeout(25000) } = {}) {
  if (!apiKey) throw new Error('OpenAI APIキーを先に保存してください。');
  const response = await fetchImpl('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` }, signal
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`モデル一覧を取得できませんでした（HTTP ${response.status}）。APIキーのモデル一覧の参照権限を確認してください。`);
  }
  const data = await response.json();
  if (!Array.isArray(data?.data)) throw new Error('APIのモデル一覧の形式が不正です。');
  return [...new Set(data.data.map(item => item?.id).filter(id =>
    typeof id === 'string' && /^[\w.:-]{1,150}$/.test(id) &&
    /^(?:gpt-[4-9]|o[1-9](?:-|$)|ft:(?:gpt-[4-9]|o[1-9]))/.test(id) &&
    !/(?:audio|realtime|transcrib|tts|image|search|embedding|moderation|computer|chat)/i.test(id)
  ))].sort((a, b) => a.localeCompare(b, 'en'));
}

export async function apiAnswer(request, emit, signal, { fetchImpl = fetch, apiKey = process.env.OPENAI_API_KEY, defaultModel = process.env.OPENAI_MODEL } = {}) {
  if (!apiKey) throw new Error('拡張機能の接続設定でOpenAI APIキーを保存してください。');
  const model = request.model || defaultModel;
  if (!model) throw new Error('設定でAPIのモデルIDを入力してください。');
  const response = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, instructions: request.instructions || INSTRUCTIONS, input: apiInput(request), ...(request.effort ? { reasoning: { effort: request.effort } } : {}), tools: [], tool_choice: 'none', stream: true, store: false })
  });
  if (!response.ok) {
    // Avoid echoing upstream payloads that might contain request text or credentials.
    await response.body?.cancel();
    throw new Error(`OpenAI API: HTTP ${response.status}。${response.status === 400 ? 'モデルの画像対応とエフォートを確認してください。エフォート「自動」でもお試しください。' : 'キー・モデルの利用権限・残高・利用制限を確認してください。'}`);
  }
  let completed = false;
  for await (const event of readSSE(response.body)) {
    if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') emit({ type: 'delta', text: event.delta });
    if (event.type === 'response.completed') completed = true;
    if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) throw new Error('APIの回答が完了しませんでした。文章を短くして再試行してください。');
  }
  if (!completed) throw new Error('回答の途中で接続が切れました。');
}
