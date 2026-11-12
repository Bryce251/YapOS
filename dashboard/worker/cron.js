import { MINUTE, HOUR, DAY } from './util.js';
import { expireJobs } from './jobs.js';
import { STATE_TTL } from './auth.js';

export const PUBLIC_STALE = 2 * HOUR;
export const SNAPSHOT_STALE = DAY;

export async function cleanup(db, t) {
  await expireJobs(db, t);
  const window = Math.floor(t / MINUTE);
  const results = await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires <= ?').bind(t),
    db.prepare('DELETE FROM oauth_states WHERE created < ?').bind(t - STATE_TTL),
    db.prepare('DELETE FROM jobs WHERE created < ?').bind(t - HOUR),
    db.prepare('DELETE FROM rate WHERE "window" < ?').bind(window - 2),
    db.prepare('DELETE FROM grants WHERE confirmed_at < ?').bind(t - DAY),
    db.prepare('DELETE FROM user_servers WHERE updated < ?').bind(t - DAY),
    db.prepare('DELETE FROM public_pages WHERE updated < ?').bind(t - PUBLIC_STALE),
    db.prepare('DELETE FROM snapshots WHERE updated < ?').bind(t - SNAPSHOT_STALE),
  ]);
  const names = ['sessions', 'states', 'jobs', 'rate', 'grants', 'userServers', 'publicPages', 'snapshots'];
  const removed = {};
  results.forEach((r, i) => {
    removed[names[i]] = Number((r && r.meta && r.meta.changes) || 0);
  });
  return removed;
}
