import { HttpError } from './util.js';
import { PROFILE_STALE } from './profiles.js';

export const NOT_REAL = "That isn't a real Yapin' account. Check the id.";
export const STILL_CHECKING = "YapOS is still checking that this is a real Yapin' account. Try again in a few seconds.";
export const NO_ACCOUNT_RESULT = "No Yapin' account has this id";
export const ACCOUNT_FREE_KINDS = new Set(['global.hide', 'global.show', 'party.board.hide', 'party.board.show', 'giver.revoke']);

const lower = (id) => String(id ?? '').toLowerCase();

export async function accountOf(db, id) {
  const key = lower(id);
  const [prof, sess, act] = await Promise.all([
    db.prepare('SELECT missing, fetched FROM profiles WHERE id = ?').bind(key).first(),
    db.prepare('SELECT 1 AS x FROM sessions WHERE LOWER(user_id) = ? LIMIT 1').bind(key).first(),
    db.prepare('SELECT 1 AS x FROM activity_sessions WHERE LOWER(user_id) = ? LIMIT 1').bind(key).first().catch(() => null),
  ]);
  if (sess || act) return { state: 'real', fetched: prof ? Number(prof.fetched) || 0 : 0 };
  if (prof && !Number(prof.missing)) return { state: 'real', fetched: Number(prof.fetched) || 0 };
  if (prof) return { state: 'fake', fetched: Number(prof.fetched) || 0 };
  return { state: 'checking', fetched: 0 };
}

export async function askAboutAccount(db, id, t) {
  await db
    .prepare('INSERT INTO profile_wanted (id, asked, given) VALUES (?, ?, 0) ON CONFLICT (id) DO UPDATE SET asked = excluded.asked')
    .bind(lower(id), t)
    .run();
}

export async function accountState(db, id, t) {
  const acct = await accountOf(db, id);
  if (acct.state === 'checking' || (acct.state === 'fake' && acct.fetched < t - PROFILE_STALE)) await askAboutAccount(db, id, t);
  return acct.state;
}

export async function requireAccount(db, a, spec, t) {
  if (ACCOUNT_FREE_KINDS.has(a.kind)) return;
  const state = await accountState(db, a.user, t);
  if (state === 'fake') throw new HttpError(400, 'not_a_user', NOT_REAL);
  if (state === 'checking' && spec.instant) throw new HttpError(409, 'checking_user', STILL_CHECKING);
}

export function noAccountStatement(db, id, t) {
  return db
    .prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, NULL, NULL, NULL, 1, ?) ON CONFLICT (id) DO UPDATE SET username = NULL, display_name = NULL, avatar_url = NULL, missing = 1, fetched = excluded.fetched')
    .bind(lower(id), t);
}
