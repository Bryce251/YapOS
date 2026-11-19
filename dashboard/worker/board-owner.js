import { ID_RE } from './util.js';

export const BOARD_HIDDEN_TEXT = 'Hidden from leaderboards';

let owner = null;

export function ownerFromEnv(env) {
  const raw = env && typeof env.PARTY_OWNER_ID === 'string' ? env.PARTY_OWNER_ID.trim() : '';
  return raw && ID_RE.test(raw) ? raw.toLowerCase() : null;
}

export function useBoardOwner(env) {
  owner = ownerFromEnv(env);
  return owner;
}

export function boardOwnerId() {
  return owner;
}

export function isBoardOwner(id) {
  return Boolean(owner && typeof id === 'string' && id.toLowerCase() === owner);
}

export function notOwnerSql(col) {
  return owner ? `LOWER(${col}) != '${owner}'` : '1 = 1';
}

export function rerankWithout(list, skip = isBoardOwner, idOf = (r) => r && r.id) {
  if (!Array.isArray(list)) return [];
  const gone = list.filter((r) => r && typeof r === 'object' && skip(idOf(r)));
  if (!gone.length) return list;
  return list
    .filter((r) => !(r && typeof r === 'object' && skip(idOf(r))))
    .map((r) => {
      if (!r || typeof r !== 'object' || !Number.isFinite(Number(r.rank))) return r;
      const above = gone.filter((g) => Number(g.rank) < Number(r.rank)).length;
      return { ...r, rank: Math.max(1, Number(r.rank) - above) };
    });
}
