import { randomBytes } from 'node:crypto';

const PRI = { high: 0, normal: 1, low: 2 };
const IS_V2 = 1 << 15;
const NONCE_OFF_MS = 6 * 3600_000;
const plain = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);
const list = (v) => (v === undefined ? undefined : v === null ? null : [].concat(v).map(plain));
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

let nonceSeq = 0;
export function makeNonce() {
  nonceSeq = (nonceSeq + 1) % 1_679_616;
  const nonce = `y${Date.now().toString(36)}${nonceSeq.toString(36).padStart(4, '0')}${randomBytes(6).toString('base64url')}`;
  return nonce.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

export const retryableSend = (e) => e?.status === 502 || e?.status === 504 || e?.status === 0 || e?.name === 'TimeoutError' || e?.name === 'AbortError' || /fetch failed|ECONN|ENOTFOUND|socket|network|gateway connection dropped/i.test(String(e?.message || ''));
const nonceRefused = (e) => (e?.status === 400 || e?.status === 422) && /nonce/i.test(String(e?.message || ''));

export function createBudget({ bot, verified = false, log, caps = null, now = () => Date.now(), perServer = 30, windowMs = 60_000, dmChannels = null, retryDelays = [1000, 3000] } = {}) {
  const globalLimit = verified ? 300 : 30;
  const sentGlobal = [];
  const sentServer = new Map();
  const queue = [];
  const pendingEdits = new Map();
  let seq = 0;
  let timer = null;
  let stats = { sent: 0, edits: 0, coalesced: 0, waited: 0, failed: 0, retried: 0, duplicates: 0 };
  let nonceOffAt = 0;

  const nonceOn = (serverId) => {
    if (typeof bot.api !== 'function') return false;
    if (caps) return caps.state(serverId, 'nonce') !== false;
    return !nonceOffAt || now() - nonceOffAt > NONCE_OFF_MS;
  };
  const nonceOff = (serverId, reason) => {
    nonceOffAt = now();
    caps?.mark(serverId, 'nonce', false, reason);
  };

  async function post(serverId, channelId, body) {
    const nonce = makeNonce();
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await bot.api('POST', `/channels/${channelId}/messages`, { ...body, nonce });
        if (out?.duplicate) stats.duplicates++;
        return out?.message ?? null;
      } catch (e) {
        if (nonceRefused(e)) {
          nonceOff(serverId, e?.message);
          return bot.api('POST', `/channels/${channelId}/messages`, body).then((out) => out?.message ?? null);
        }
        if (!retryableSend(e) || attempt >= retryDelays.length) throw e;
        stats.retried++;
        log?.debug?.(`send to ${channelId} failed (${e?.status || e?.message}), trying again with the same nonce`);
        await sleep(retryDelays[attempt]);
      }
    }
  }

  function runSend(serverId, channelId, content, opts, layout) {
    const hasFiles = opts.files != null && [].concat(opts.files).length > 0;
    if (hasFiles || !nonceOn(serverId)) {
      return layout
        ? () => bot.sendLayout(channelId, layout, { replyTo: opts.replyTo })
        : () => bot.send(channelId, content, opts);
    }
    const body = layout
      ? { flags: IS_V2, reply_to: opts.replyTo, components: list(layout) }
      : { content: String(content ?? ''), reply_to: opts.replyTo, embeds: list(opts.embeds || undefined), components: list(opts.components || undefined), sticker_id: opts.stickerId };
    return () => post(serverId, channelId, body);
  }

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
      const run = runSend(serverId, channelId, content, opts, layout);
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
        trimEdits(minGap);
        stats.edits++;
        Promise.resolve().then(entry.job).then(
          (m) => entry.waiters.forEach((w) => w.resolve(m)),
          (e) => entry.waiters.forEach((w) => w.reject(e)),
        );
      };
      const t = setTimeout(fire, lastEdit.has(messageId) ? Math.max(0, lastEdit.get(messageId) + minGap - now()) : 0);
      entry.timer = t;
      t.unref?.();
      rememberEdit(messageId, minGap);
    });
  }
  const lastEdit = new Map();
  const MAX_EDIT_MEMORY = 2000;

  function rememberEdit(messageId, minGap) {
    lastEdit.delete(messageId);
    lastEdit.set(messageId, now());
    trimEdits(minGap);
  }

  function trimEdits(minGap) {
    if (lastEdit.size <= MAX_EDIT_MEMORY) return;
    const cut = now() - Math.max(minGap, 60_000);
    for (const [id, at] of lastEdit) {
      if (lastEdit.size <= MAX_EDIT_MEMORY / 2 && at > cut) break;
      if (pendingEdits.has(id)) continue;
      lastEdit.delete(id);
    }
  }

  function cancelEdit(messageId) {
    const cur = pendingEdits.get(messageId);
    if (!cur) return false;
    pendingEdits.delete(messageId);
    clearTimeout(cur.timer);
    stats.coalesced++;
    cur.waiters.forEach((w) => w.resolve(null));
    return true;
  }

  return {
    send,
    edit,
    cancelEdit,
    headroom,
    get rememberedEdits() { return lastEdit.size; },
    get queued() { return queue.length; },
    get stats() { return { ...stats, queued: queue.length, globalLimit, nonce: nonceOn(null) }; },
    _pump: pump,
    verified,
  };
}
