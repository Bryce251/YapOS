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
