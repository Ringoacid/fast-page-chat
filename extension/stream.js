// SSE frames may be split at any byte, including inside Japanese UTF-8 characters.
export async function* readSSE(body) {
  if (!body) throw new Error('応答ストリームがありません。');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  function parse(frame) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return null;
    return JSON.parse(data);
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const event = parse(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (event) yield event;
      }
      if (done) {
        if (buffer.trim()) { const event = parse(buffer); if (event) yield event; }
        break;
      }
      if (buffer.length > 4_000_000) throw new Error('応答イベントが大きすぎます。');
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
