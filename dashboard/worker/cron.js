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
import { clanCleanupStatements } from './clans.js';
import { inboxCleanupStatements } from './inbox.js';
import { linkCleanupStatements } from './activity-auth.js';
import { awardMonth, monthCleanup } from './party-leaderboard.js';
import { banCleanupStatements, BAN_CLEANUP_NAMES } from './party-mod.js';
import { avatarCleanupStatements } from './avatar-store.js';
import { chunkCleanupStatements } from './image-chunks.js';
import { likesCleanupStatements } from './profile-likes.js';
import { songCleanupStatements } from './songs.js';

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
    db.prepare('DELETE FROM profiles WHERE fetched < ? AND NOT EXISTS (SELECT 1 FROM public_profiles p WHERE p.user_id = LOWER(profiles.id))').bind(t - PROFILE_KEEP),
    ...linkCleanupStatements(db, t),
    ...cleanupStatements(db, t),
    ...resultsCleanupStatements(db, t),
    ...dailyCleanupStatements(db, t),
    ...profileCleanupStatements(db, t),
    ...packReportsCleanupStatements(db, t),
    ...statsCleanupStatements(db, t),
    ...ownerCleanupStatements(db, t),
  ]);
  const names = ['sessions', 'states', 'jobs', 'rate', 'grants', 'userServers', 'publicPages', 'snapshots', 'profileWanted', 'profiles', 'activityLinks', 'activitySessions', 'dismissedReports', 'extraReports', 'orphanReportTexts', 'orphanReportReplays', 'partyResults', 'partyXp', 'partyShards', 'dailyScores', 'publicProfiles', 'profileSettings', 'packReports', 'serverStats', 'ownerActions'];
  const removed = {};
  results.forEach((r, i) => {
    removed[names[i]] = Number((r && r.meta && r.meta.changes) || 0);
  });
  const modResults = await db.batch(banCleanupStatements(db, t));
  modResults.forEach((r, i) => {
    removed[BAN_CLEANUP_NAMES[i]] = Number((r && r.meta && r.meta.changes) || 0);
  });
  const clanResults = await db.batch(clanCleanupStatements(db, t));
  removed.clanJoins = Number((clanResults[0] && clanResults[0].meta && clanResults[0].meta.changes) || 0);
  removed.clanActions = Number((clanResults[1] && clanResults[1].meta && clanResults[1].meta.changes) || 0);
  removed.clanInvites = Number((clanResults[2] && clanResults[2].meta && clanResults[2].meta.changes) || 0);
  const inboxResults = await db.batch(inboxCleanupStatements(db, t));
  removed.notifications = Number((inboxResults[0] && inboxResults[0].meta && inboxResults[0].meta.changes) || 0);
  const avatarResults = await db.batch(avatarCleanupStatements(db, t));
  removed.profileAvatars = Number((avatarResults[0] && avatarResults[0].meta && avatarResults[0].meta.changes) || 0);
  removed.profileAvatarStills = Number((avatarResults[1] && avatarResults[1].meta && avatarResults[1].meta.changes) || 0);
  const chunkResults = await db.batch(chunkCleanupStatements(db, t));
  removed.imageChunks = chunkResults.reduce((s, r) => s + Number((r && r.meta && r.meta.changes) || 0), 0);
  const likeResults = await db.batch(likesCleanupStatements(db, t));
  removed.profileLikes = Number((likeResults[0] && likeResults[0].meta && likeResults[0].meta.changes) || 0);
  removed.profileLikePings = Number((likeResults[1] && likeResults[1].meta && likeResults[1].meta.changes) || 0);
  const songResults = await db.batch(songCleanupStatements(db, t));
  removed.songUploads = Number((songResults[1] && songResults[1].meta && songResults[1].meta.changes) || 0);
  removed.songChunks = [0, 2, 3].reduce((s, i) => s + Number((songResults[i] && songResults[i].meta && songResults[i].meta.changes) || 0), 0);
  const season = await awardMonth(db, t).catch(() => ({ awarded: 0 }));
  removed.partySeasonAwards = season.awarded;
  removed.partyPointsMonth = await monthCleanup(db, t).catch(() => 0);
  return removed;
}
