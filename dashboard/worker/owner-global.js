export const GLOBAL_OWNER_KINDS = Object.freeze({
  'global.hide': Object.freeze({ label: 'Hide from the global leaderboard', input: 'none', gift: false, instant: true }),
  'global.show': Object.freeze({ label: 'Show on the global leaderboard again', input: 'none', gift: false, instant: true }),
});

const lower = (id) => String(id ?? '').toLowerCase();

export async function globalHiddenIds(db) {
  const res = await db.prepare('SELECT user_id FROM global_board_hidden').all();
  return new Set(((res && res.results) || []).map((r) => lower(r.user_id)));
}

export async function isGlobalHidden(db, id) {
  const row = await db.prepare('SELECT 1 AS x FROM global_board_hidden WHERE user_id = ?').bind(lower(id)).first();
  return Boolean(row);
}

export function withoutHidden(list, hidden) {
  if (!Array.isArray(list)) return [];
  if (!hidden.size) return list;
  let rank = 0;
  const out = [];
  for (const row of list) {
    if (row && typeof row === 'object' && hidden.has(lower(row.id))) continue;
    rank += 1;
    out.push(row && typeof row === 'object' ? { ...row, rank } : row);
  }
  return out;
}

export async function globalActionPlan(db, a, ownerId, t) {
  if (a.kind === 'global.hide') {
    const already = await isGlobalHidden(db, a.user);
    return {
      result: already ? 'They were already hidden from the global leaderboard.' : 'Hid them from the global leaderboard (Levels and Shards). Their Shards and XP are kept, and their profile page still works.',
      stmts: [db.prepare('INSERT INTO global_board_hidden (user_id, by_id, at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING').bind(lower(a.user), lower(ownerId), t)],
    };
  }
  if (a.kind === 'global.show') {
    const already = await isGlobalHidden(db, a.user);
    return {
      result: already ? 'They show on the global leaderboard again.' : 'They were already on the global leaderboard.',
      stmts: [db.prepare('DELETE FROM global_board_hidden WHERE user_id = ?').bind(lower(a.user))],
    };
  }
  return null;
}
