import { MINUTE, HOUR, DAY } from './util.js';
import { expireJobs } from './jobs.js';
import { STATE_TTL } from './auth.js';
import { PROFILE_KEEP, WANTED_TTL } from './profiles.js';
import { cleanupStatements } from './reports.js';
import { resultsCleanupStatements } from './party-results.js';
import { dailyCleanupStatements } from './party-daily.js';
import { profileCleanupStatements } from './public-profiles.js';
import { packReportsCleanupStatements } from './pack-browse.js';
import { statsCleanupStatements } from './server-stats.js';
import { ownerCleanupStatements } from './owner.js';

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
    db.prepare('DELETE FROM profile_wanted WHERE asked < ?').bind(t - WANTED_TTL),
    db.prepare('DELETE FROM profiles WHERE fetched < ?').bind(t - PROFILE_KEEP),
    ...cleanupStatements(db, t),
    ...resultsCleanupStatements(db, t),
    ...dailyCleanupStatements(db, t),
    ...profileCleanupStatements(db, t),
    ...packReportsCleanupStatements(db, t),
    ...statsCleanupStatements(db, t),
    ...ownerCleanupStatements(db, t),
  ]);
  const names = ['sessions', 'states', 'jobs', 'rate', 'grants', 'userServers', 'publicPages', 'snapshots', 'profileWanted', 'profiles', 'dismissedReports', 'extraReports', 'orphanReportTexts', 'partyResults', 'partyXp', 'partyShards', 'dailyScores', 'publicProfiles', 'profileSettings', 'packReports', 'serverStats', 'ownerActions'];
  const removed = {};
  results.forEach((r, i) => {
    removed[names[i]] = Number((r && r.meta && r.meta.changes) || 0);
  });
  return removed;
}
