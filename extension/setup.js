export const PRIVACY_CONSENT_VERSION = 1;
export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_ENDPOINT = 'http://127.0.0.1:4318';
export const NATIVE_HOST = 'com.fastpagechat.bridge';

export function hasDataConsent(settings) {
  return settings?.privacyConsentVersion === PRIVACY_CONSENT_VERSION;
}

export function requireDataConsent(settings) {
  if (!hasDataConsent(settings)) throw new Error('最初にデータの取り扱いを確認してください。');
}

export function assertCompatibleBridge(reply) {
  if (reply?.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    throw new Error('補助アプリの更新が必要です。最新版をインストールして、もう一度接続してください。');
  }
  return reply;
}

export function validateNativeConnection(reply) {
  if (!reply?.ok) throw new Error(reply?.error || '補助アプリに接続できませんでした。');
  assertCompatibleBridge(reply);
  if (reply.endpoint !== BRIDGE_ENDPOINT || !/^[a-f0-9]{64}$/.test(reply.token || '')) {
    throw new Error('補助アプリの接続情報が正しくありません。補助アプリを入れ直してください。');
  }
  return reply;
}

export function trustedLoginUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['auth.openai.com', 'auth0.openai.com', 'platform.openai.com', 'chatgpt.com', 'auth.chatgpt.com'].includes(url.hostname)) {
    throw new Error('ログイン先を確認できませんでした。補助アプリを更新してください。');
  }
  return url.href;
}

export function resolveTitleConnection(settings, record) {
  if (!settings.titleProvider || settings.titleProvider === 'same') {
    return { provider: record.provider, model: record.model || '' };
  }
  return { provider: settings.titleProvider, model: settings.titleModel || 'gpt-6-luna' };
}
