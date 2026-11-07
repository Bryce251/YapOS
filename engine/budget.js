const PRI = { high: 0, normal: 1, low: 2 };

export function createBudget({ bot, verified = false, log, now = () => Date.now(), perServer = 30, windowMs = 60_000, dmChannels = null } = {}) {
  const globalLimit = verified ? 300 : 30;
  const sentGlobal = [];
  const sentServer = new Map();
  const queue = [];
  const pendingEdits = new Map();
  let seq = 0;
  let timer = null;
  let stats = { sent: 0, edits: 0, coalesced: 0, waited: 0, failed: 0 };

  const prune = (arr) => { const cut = now() - windowMs; while (arr.length && arr[0] <= cut) arr.shift(); };
  const serverArr = (id) => { const k = id || 'dm'; if (!sentServer.has(k)) sentServer.set(k, []); return sentServer.get(k); };

  function headroom(serverId) {
    prune(sentGlobal);
    const s = serverArr(serverId); prune(s);
    return { global: globalLimit - sentGlobal.length, globalLimit, server: perServer - s.length, serverLimit: perServer };
  }

  function canSend(item) {
    const h = headroom(item.serverId);
    const reserve = item.pri === PRI.low ? 0.2 : item.pri === PRI.normal ? 0.05 : 0;
    const needGlobal = !item.exemptGlobal;
    const serverOk = h.server > Math.floor(perServer * reserve);
    const globalOk = !needGlobal || h.global > Math.floor(globalLimit * reserve);
    return serverOk && globalOk;
  }

  function nextWait(item) {
    const s = serverArr(item.serverId);
    const waits = [];
    if (s.length) waits.push(s[0] + windowMs - now());
    if (!item.exemptGlobal && sentGlobal.length) waits.push(sentGlobal[0] + windowMs - now());
    return Math.max(50, Math.min(...(waits.length ? waits : [250])));
  }

  function pump() {
    timer = null;
    queue.sort((a, b) => a.pri - b.pri || a.seq - b.seq);
    let minWait = Infinity;
    for (let i = 0; i < queue.length; ) {
      const item = queue[i];
      if (!canSend(item)) { minWait = Math.min(minWait, nextWait(item)); i++; continue; }
      queue.splice(i, 1);
      const t = now();
      serverArr(item.serverId).push(t);
      if (!item.exemptGlobal) sentGlobal.push(t);
      stats.sent++;
      Promise.resolve().then(item.run).then(item.resolve, (e) => { stats.failed++; item.reject(e); });
    }
    if (queue.length && minWait < Infinity) { stats.waited++; timer = setTimeout(pump, minWait); timer.unref?.(); }
  }
  const kick = () => { if (!timer) { timer = setTimeout(pump, 0); timer.unref?.(); } };

  function send({ serverId = null, channelId, content = '', opts = {}, layout = null, priority = 'normal', key = null }) {
    if (!channelId) return Promise.reject(new Error('budget.send needs a channelId'));
    return new Promise((resolve, reject) => {
      if (key) {
        const old = queue.findIndex((q) => q.key === key);
        if (old >= 0) { stats.coalesced++; queue[old].resolve(null); queue.splice(old, 1); }
      }
      const run = layout
        ? () => bot.sendLayout(channelId, layout, { replyTo: opts.replyTo })
        : () => bot.send(channelId, content, opts);
      queue.push({ pri: PRI[priority] ?? 1, seq: seq++, serverId, key, run, resolve, reject, exemptGlobal: !!opts.replyTo && priority === 'high' });
      kick();
    });
  }

  function edit({ channelId, messageId, content, opts = {}, layout = null, minGap = 1500 }) {
    return new Promise((resolve, reject) => {
      const job = layout ? () => bot.editLayout(channelId, messageId, layout) : () => bot.edit(channelId, messageId, content, opts);
      const cur = pendingEdits.get(messageId);
      if (cur) { cur.job = job; cur.waiters.push({ resolve, reject }); stats.coalesced++; return; }
      const entry = { job, waiters: [{ resolve, reject }], last: 0 };
      pendingEdits.set(messageId, entry);
      const fire = () => {
        pendingEdits.delete(messageId);
        stats.edits++;
        Promise.resolve().then(entry.job).then(
          (m) => entry.waiters.forEach((w) => w.resolve(m)),
          (e) => entry.waiters.forEach((w) => w.reject(e)),
        );
      };
      const t = setTimeout(fire, lastEdit.has(messageId) ? Math.max(0, lastEdit.get(messageId) + minGap - now()) : 0);
      t.unref?.();
      lastEdit.set(messageId, now());
    });
  }
  const lastEdit = new Map();

  return {
    send,
    edit,
    headroom,
    get queued() { return queue.length; },
    get stats() { return { ...stats, queued: queue.length, globalLimit }; },
    _pump: pump,
    verified,
  };
}
