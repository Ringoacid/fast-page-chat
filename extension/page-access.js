import { extractPage } from './extract.js';

export function checkTab(tab) {
  if (!Number.isInteger(tab?.id) || tab.id < 0) throw new Error('対象タブが見つかりません。読みたいページでツールバーの「F」ボタンを押してください。');
  // url is a permission-gated property, not proof that this is an internal page.
  if (tab.url && !/^https?:\/\//.test(tab.url)) throw new Error('ブラウザの設定画面や新しいタブは取得できません。通常のWebページを開いてください。');
}

export function pageAccessError(error) {
  if (/Cannot access|Missing host permission|permission to access|not allowed to access|extensions gallery cannot be scripted/i.test(error.message)) {
    return new Error('このページへのアクセス権がありません。読みたいページを表示し、ブラウザ上部のツールバーにある「F」ボタンをクリックしてください。パネル内の「再取得」だけでは権限は付与されません。');
  }
  return error;
}

export async function captureTab(api, tab, scope) {
  checkTab(tab);
  try {
    const results = await api.scripting.executeScript({ target: { tabId: tab.id }, func: extractPage, args: [scope] });
    if (results[0]?.error) throw new Error(results[0].error.message || '本文を取得できません。');
    const result = results[0]?.result;
    if (!result?.text) throw new Error('本文を取得できません。ページで文章を選択するか、読み込み後に再取得してください。');
    const { sourceUrl, ...page } = result;
    const identity = { url: sourceUrl || tab.url || page.url, documentId: results[0].documentId };
    if (!/^https?:\/\//.test(identity.url)) throw new Error('通常のWebページを開いてください。');
    return { page, identity };
  } catch (error) { throw pageAccessError(error); }
}

export async function readIdentity(api, tab) {
  checkTab(tab);
  try {
    const results = await api.scripting.executeScript({ target: { tabId: tab.id }, func: () => location.href });
    if (results[0]?.error) throw new Error(results[0].error.message);
    if (!results[0]?.result) throw new Error('ページの確認に失敗しました。再取得してください。');
    return { url: results[0].result, documentId: results[0].documentId };
  } catch (error) { throw pageAccessError(error); }
}

export function sameDocument(a, b) {
  return Boolean(a && b && a.url === b.url && (!a.documentId || !b.documentId || a.documentId === b.documentId));
}
