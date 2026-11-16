export const KO_MIN_PLAYERS = 2;
export const KO_ROUND_CAP = 40;
export const SURVIVOR_POINTS = 300;

export function koSetting() {
  return { id: 'knockout', label: '🥊 Knockout', type: 'toggle', default: true, fun: true };
}

export function koOn(settings, count) {
  return Boolean(settings) && settings.knockout !== false && count >= KO_MIN_PLAYERS;
}

export function koOut(alive, ranked) {
  const live = [...new Set((alive || []).filter(Number.isInteger))];
  if (live.length <= 1) return [];
  const seen = new Set();
  const order = [];
  for (const x of ranked || []) {
    if (!x || !live.includes(x.s) || seen.has(x.s)) continue;
    seen.add(x.s);
    order.push({ s: x.s, ok: Boolean(x.ok) });
  }
  for (const s of live) if (!seen.has(s)) order.push({ s, ok: false });
  const fails = order.filter((x) => !x.ok);
  if (fails.length === order.length) return [];
  const cap = live.length > 2 ? live.length - 2 : 1;
  if (!fails.length) return [order[order.length - 1].s];
  return fails
    .slice()
    .reverse()
    .slice(0, cap)
    .map((x) => x.s);
}

export function koTotal(r, alive) {
  const n = Array.isArray(alive) ? alive.length : 0;
  return n <= 2 ? r : r + n - 2;
}

export function koFaces(slots, bySlot, face, mine) {
  return (slots || []).filter((s) => bySlot.has(s)).map((s) => ({ ...face(bySlot.get(s), mine), slot: s }));
}

export function koModel(st, mine, bySlot, face) {
  if (!st || !st.ko) return null;
  const alive = Array.isArray(st.al) ? st.al : [];
  const outs = Array.isArray(st.ot) ? st.ot : [];
  return {
    alive: koFaces(alive, bySlot, face, mine),
    left: alive.length,
    out: koFaces(Array.isArray(st.kx) ? st.kx : [], bySlot, face, mine),
    imOut: mine !== null && outs.includes(mine),
    imAlive: mine !== null && alive.includes(mine),
    duel: alive.length === 2,
    champ: alive.length === 1 && bySlot.has(alive[0]) ? { ...face(bySlot.get(alive[0]), mine), slot: alive[0] } : null,
  };
}

export function koLine(k) {
  if (!k) return '';
  if (k.champ) return k.champ.isMe ? '👑 You are the last one standing!' : `👑 ${k.champ.name} is the last one standing!`;
  if (k.duel) return '🥊 Final showdown, 1 vs 1!';
  return `🥊 ${k.left} still standing`;
}

export function koOutText(k) {
  if (!k || !k.out.length) return '';
  const names = k.out.map((p) => (p.isMe ? 'You' : p.name));
  const list = names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  return `👋 ${list} ${names.length === 1 && names[0] !== 'You' ? 'is' : 'are'} out!`;
}
