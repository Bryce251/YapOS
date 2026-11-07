const CANCEL = /^(cancel|stop|quit|exit|nevermind|nvm)$/i;

export function createPrompts({ timeoutMs = 120_000 } = {}) {
  const waiting = new Map();
  const key = (channelId, userId) => `${channelId}:${userId}`;

  function ask(channelId, userId, { timeout = timeoutMs } = {}) {
    const k = key(channelId, userId);
    waiting.get(k)?.resolve({ cancelled: true, replaced: true });
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiting.delete(k); resolve({ timedOut: true }); }, timeout);
      timer.unref?.();
      waiting.set(k, {
        resolve: (r) => { clearTimeout(timer); waiting.delete(k); resolve(r); },
      });
    });
  }

  function offer(msg) {
    const k = key(msg.channel_id, msg.author_id);
    const w = waiting.get(k);
    if (!w) return false;
    const text = String(msg.content ?? '').trim();
    w.resolve(CANCEL.test(text) ? { cancelled: true, message: msg } : { text, message: msg });
    return true;
  }

  const isWaiting = (channelId, userId) => waiting.has(key(channelId, userId));

  return { ask, offer, isWaiting };
}
