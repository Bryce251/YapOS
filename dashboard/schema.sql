CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires);
CREATE INDEX IF NOT EXISTS sessions_last_seen ON sessions (last_seen);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  next TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_states_created ON oauth_states (created);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  user_id TEXT NOT NULL,
  server_id TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  error TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs (status, created);
CREATE INDEX IF NOT EXISTS jobs_user ON jobs (user_id, type, status, created);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs (created);

CREATE TABLE IF NOT EXISTS user_servers (
  user_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS grants (
  user_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  level TEXT NOT NULL,
  confirmed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, server_id)
);
CREATE INDEX IF NOT EXISTS grants_confirmed ON grants (confirmed_at);

CREATE TABLE IF NOT EXISTS snapshots (
  server_id TEXT NOT NULL,
  part TEXT NOT NULL,
  data TEXT NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (server_id, part)
);

CREATE TABLE IF NOT EXISTS public_pages (
  server_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate (
  key TEXT NOT NULL,
  "window" INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, "window")
);
CREATE INDEX IF NOT EXISTS rate_window ON rate ("window");

CREATE TABLE IF NOT EXISTS global_board (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  username TEXT,
  display_name TEXT,
  avatar_url TEXT,
  missing INTEGER NOT NULL DEFAULT 0,
  fetched INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS profiles_fetched ON profiles (fetched);

CREATE TABLE IF NOT EXISTS profile_wanted (
  id TEXT PRIMARY KEY,
  asked INTEGER NOT NULL,
  given INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS profile_wanted_asked ON profile_wanted (asked);

CREATE TABLE IF NOT EXISTS party_admins (
  id TEXT PRIMARY KEY,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS party_reports (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL,
  drawer_id TEXT NOT NULL,
  drawer_name TEXT NOT NULL,
  drawer_username TEXT,
  reporter_id TEXT NOT NULL,
  reporter_name TEXT NOT NULL,
  ink TEXT NOT NULL DEFAULT '[]',
  word TEXT,
  at INTEGER NOT NULL,
  created INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  dismissed_at INTEGER,
  dismissed_by TEXT
);
CREATE INDEX IF NOT EXISTS party_reports_created ON party_reports (created, id);
CREATE INDEX IF NOT EXISTS party_reports_status ON party_reports (status, created, id);
CREATE INDEX IF NOT EXISTS party_reports_pair ON party_reports (reporter_id, drawer_id, created);
CREATE INDEX IF NOT EXISTS party_reports_ip ON party_reports (ip_hash, created);

CREATE TABLE IF NOT EXISTS party_report_texts (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  context TEXT,
  ip_hash TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS party_report_texts_ip ON party_report_texts (ip_hash, created);

CREATE TABLE IF NOT EXISTS party_bans (
  id TEXT PRIMARY KEY,
  name TEXT,
  username TEXT,
  reason TEXT,
  banned_by TEXT NOT NULL,
  banned_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS party_bans_at ON party_bans (banned_at);

CREATE TABLE IF NOT EXISTS party_stats (
  user_id TEXT PRIMARY KEY,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  by_game TEXT NOT NULL DEFAULT '{}',
  counters TEXT NOT NULL DEFAULT '{}',
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS party_xp (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  xp INTEGER NOT NULL,
  game TEXT NOT NULL,
  won INTEGER NOT NULL DEFAULT 0,
  day TEXT NOT NULL,
  at INTEGER NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS party_xp_claimed ON party_xp (claimed, at, id);
CREATE INDEX IF NOT EXISTS party_xp_user_day ON party_xp (user_id, day);

CREATE TABLE IF NOT EXISTS party_results (
  hash TEXT PRIMARY KEY,
  game TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS party_results_created ON party_results (created);

CREATE TABLE IF NOT EXISTS party_daily_scores (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  username TEXT,
  score INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (day, kind, user_id)
);
CREATE INDEX IF NOT EXISTS party_daily_scores_rank ON party_daily_scores (day, kind, score DESC, ms ASC);

CREATE TABLE IF NOT EXISTS party_daily_streaks (
  user_id TEXT PRIMARY KEY,
  last_day TEXT NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0,
  best INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS party_packs (
  code TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  words TEXT NOT NULL DEFAULT '[]',
  trivia TEXT NOT NULL DEFAULT '[]',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS party_packs_owner ON party_packs (owner_id, created);
