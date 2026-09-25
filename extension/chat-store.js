export const DEFAULT_SKILLS = [
  { id: 'translate', title: '日本語に翻訳', prompt: '取得した本文を、段落と見出しを保ち、内容を省略せず自然な日本語に翻訳してください。', createdAt: 1 },
  { id: 'summarize', title: '要点をまとめる', prompt: '取得した本文の要点を日本語で簡潔にまとめてください。重要な結論と、その根拠を分けて説明してください。', createdAt: 2 },
  { id: 'explain', title: 'わかりやすく説明', prompt: 'このページの内容を、予備知識がない人にもわかるように日本語で説明してください。専門用語には短い説明を添えてください。', createdAt: 3 }
];
export function openStore(factory = indexedDB) {
  return new Promise((resolve, reject) => {
    const request = factory.open('fast-page-chat', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('chats', { keyPath: 'id' });
      const skills = request.result.createObjectStore('skills', { keyPath: 'id' });
      for (const skill of DEFAULT_SKILLS) skills.put(skill);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(new ChatStore(request.result));
  });
}
class ChatStore {
  constructor(db) { this.db = db; db.onversionchange = () => db.close(); }
  run(store, mode, action) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(store, mode); let result, failure;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failure || transaction.error || new Error('保存できませんでした。'));
      transaction.onerror = () => {};
      action(transaction.objectStore(store), value => { result = value; }, error => { failure = error; transaction.abort(); });
    });
  }
  list(store) { return this.run(store, 'readonly', (s, done) => { s.getAll().onsuccess = e => done(e.target.result); }); }
  getChat(id) { return this.run('chats', 'readonly', (s, done) => { s.get(id).onsuccess = e => done(e.target.result); }); }
  putSkill(skill) { return this.run('skills', 'readwrite', s => s.put(skill)); }
  delete(store, id) { return this.run(store, 'readwrite', s => s.delete(id)); }
  saveChat(chat) {
    return this.run('chats', 'readwrite', (s, done, fail) => {
      s.get(chat.id).onsuccess = e => {
        const previous = e.target.result;
        if ((previous?.revision || 0) !== (chat.revision || 0)) return fail(new Error('このチャットは別のパネルで更新されました。履歴から開き直してください。'));
        const next = { ...chat, revision: (chat.revision || 0) + 1 };
        s.put(next); done(next.revision);
      };
    });
  }
  restore(store, value) {
    return this.run(store, 'readwrite', (s, done, fail) => {
      s.get(value.id).onsuccess = e => {
        if (e.target.result) return fail(new Error('同じ項目がすでに存在します。'));
        s.add(value); done(value);
      };
    });
  }
}
export function createChat(page, provider, model, question, now = Date.now()) {
  return { id: crypto.randomUUID(), title: question.replace(/\s+/g, ' ').slice(0, 45), page: structuredClone(page), provider, model,
    createdAt: now, updatedAt: now, pinned: false, revision: 0, messages: [] };
}
export function conversationInput(messages) {
  const pairs = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const user = messages[i], answer = messages[i + 1];
    if (user.role === 'user' && answer.role === 'assistant' && answer.status === 'complete') {
      pairs.push([{ role: 'user', content: user.text }, { role: 'assistant', content: answer.text }]); i++;
    }
  }
  const result = pairs.slice(-6).flat();
  if (result.some(m => m.content.length > 30000)) throw new Error('直前の回答が長いため、新しいチャットで質問してください。');
  return result;
}
export function recoverInterrupted(chat) {
  let changed = false;
  for (const message of chat.messages) if (message.status === 'streaming') { message.status = 'interrupted'; changed = true; }
  return changed;
}
export function sortChats(chats, query = '') {
  const term = query.trim().toLocaleLowerCase();
  return chats.filter(c => !term || `${c.title}\n${c.page.title}\n${c.messages.map(m => m.text).join('\n')}`.toLocaleLowerCase().includes(term))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}
export function chatMarkdown(chat) {
  return `# ${chat.title}\n\n参照: ${chat.page.title}\n${chat.page.url}\n\n` + chat.messages.map(m => `## ${m.role === 'user' ? 'You' : 'Assistant'}${m.status && m.status !== 'complete' ? '（未完了）' : ''}\n\n${m.text}\n`).join('\n');
}
