import { shuffle } from '../engine.js';

export const TEAMS = Object.freeze([
  Object.freeze({ id: 'r', name: 'Red', emoji: '🟥' }),
  Object.freeze({ id: 'b', name: 'Blue', emoji: '🟦' }),
]);
export const TEAM_IDS = Object.freeze(TEAMS.map((t) => t.id));
export const TEAM_MS = 6000;
export const TEAMS_OFF = 'off';
export const TEAMS_TWO = 'two';

export function teamSetting() {
  return {
    id: 'teams',
    label: 'Teams',
    type: 'choice',
    options: [
      { value: TEAMS_OFF, label: 'Off' },
      { value: TEAMS_TWO, label: '🟥 🟦 2 teams' },
    ],
    default: TEAMS_OFF,
  };
}

export function teamInfo(id) {
  return TEAMS.find((t) => t.id === id) || null;
}

export function wantsTeams(settings) {
  return Boolean(settings) && settings.teams === TEAMS_TWO;
}

export function cleanTeams(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [slot, t] of Object.entries(raw)) if (/^\d+$/.test(slot) && TEAM_IDS.includes(t)) out[slot] = t;
  return Object.keys(out).length ? out : null;
}

export function teamOf(teams, slot) {
  if (!teams || slot === null || slot === undefined) return null;
  const t = teams[slot];
  return TEAM_IDS.includes(t) ? t : null;
}

export function splitTeams(slots, random = Math.random) {
  const list = shuffle([...new Set((slots || []).filter(Number.isInteger))], random);
  const out = {};
  list.forEach((slot, i) => {
    out[slot] = TEAM_IDS[i % TEAM_IDS.length];
  });
  return out;
}

export function teamSizes(teams) {
  const out = {};
  for (const id of TEAM_IDS) out[id] = 0;
  for (const t of Object.values(teams || {})) if (t in out) out[t] += 1;
  return out;
}

export function evenOut(sum, size, biggest) {
  if (!(size > 0) || !(biggest > size)) return sum;
  return Math.round((sum * biggest) / size);
}

export function rawTotals(teams, points) {
  const out = {};
  for (const id of TEAM_IDS) out[id] = 0;
  if (!teams) return out;
  for (const [slot, t] of Object.entries(teams)) {
    if (!(t in out)) continue;
    const n = Number(points && points[slot]);
    if (Number.isFinite(n)) out[t] += n;
  }
  return out;
}

export function teamTotals(teams, points) {
  const raw = rawTotals(teams, points);
  const sizes = teamSizes(teams);
  const biggest = Math.max(...TEAM_IDS.map((id) => sizes[id]));
  const out = {};
  for (const id of TEAM_IDS) out[id] = evenOut(raw[id], sizes[id], biggest);
  return out;
}

export function placeLate(teams, present, points) {
  if (!teams) return null;
  const live = (present || []).filter(Number.isInteger);
  const fresh = live.filter((s) => !teamOf(teams, s));
  if (!fresh.length) return null;
  const next = { ...teams };
  for (const slot of fresh) {
    const size = {};
    for (const id of TEAM_IDS) size[id] = 0;
    for (const s of live) {
      const t = teamOf(next, s);
      if (t) size[t] += 1;
    }
    const sums = teamTotals(next, points);
    const pick = TEAM_IDS.slice().sort((a, b) => size[a] - size[b] || sums[a] - sums[b] || TEAM_IDS.indexOf(a) - TEAM_IDS.indexOf(b))[0];
    next[slot] = pick;
  }
  return next;
}

export function teamWinners(teams, points) {
  const totals = teamTotals(teams, points);
  const slots = Object.keys(teams || {}).map(Number).filter(Number.isInteger);
  const best = Math.max(...TEAM_IDS.map((id) => totals[id]));
  const top = TEAM_IDS.filter((id) => totals[id] === best);
  const win = top.length === 1 ? top[0] : null;
  return { win, totals, slots: win ? slots.filter((s) => teams[s] === win).sort((a, b) => a - b) : slots.sort((a, b) => a - b) };
}

export function teamNames(teams) {
  const out = {};
  if (!teams) return out;
  for (const [slot, t] of Object.entries(teams)) {
    const info = teamInfo(t);
    if (info) out[slot] = info.name;
  }
  return out;
}

export function teamBoard(teams, players, scores, mine) {
  if (!teams) return null;
  const points = scores && scores.g ? scores.g : null;
  const bySlot = new Map((players || []).filter((p) => Number.isInteger(p.slot)).map((p) => [p.slot, p]));
  const pts = (slot) => {
    if (points && Number.isFinite(Number(points[slot]))) return Number(points[slot]);
    const p = bySlot.get(Number(slot));
    return p && Number.isFinite(p.game) ? p.game : 0;
  };
  const raw = {};
  for (const id of TEAM_IDS) raw[id] = 0;
  for (const [slot, t] of Object.entries(teams)) if (t in raw) raw[t] += pts(slot);
  const sizes = teamSizes(teams);
  const biggest = Math.max(...TEAM_IDS.map((id) => sizes[id]));
  const totals = {};
  for (const id of TEAM_IDS) totals[id] = evenOut(raw[id], sizes[id], biggest);
  const best = Math.max(...TEAM_IDS.map((id) => totals[id]));
  const leaders = TEAM_IDS.filter((id) => totals[id] === best);
  const myTeam = teamOf(teams, mine);
  return TEAMS.map((t) => ({
    id: t.id,
    name: t.name,
    emoji: t.emoji,
    pts: totals[t.id],
    boost: sizes[t.id] > 0 && sizes[t.id] < biggest ? { size: sizes[t.id], of: biggest } : null,
    lead: best > 0 && leaders.length === 1 && leaders[0] === t.id,
    mine: myTeam === t.id,
    members: Object.entries(teams)
      .filter(([, x]) => x === t.id)
      .map(([slot]) => bySlot.get(Number(slot)))
      .filter((p) => p && (p.present || pts(p.slot) > 0))
      .map((p) => ({ id: p.id, slot: p.slot, name: p.name, initials: p.initials, hue: p.hue, avatar: p.avatar || null, isMe: Boolean(p.isMe), pts: pts(p.slot) })),
  }));
}

export function finalText(board) {
  if (!board) return '';
  const [a, b] = board;
  if (a.pts === b.pts) return "It's a tie between the teams!";
  const win = a.pts > b.pts ? a : b;
  return `${win.emoji} ${win.name} team wins!`;
}
