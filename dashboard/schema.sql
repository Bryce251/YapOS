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

CREATE TABLE IF NOT EXISTS party_report_replays (
  report_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS party_report_reasons (
  report_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  note TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS party_report_reasons_reason ON party_report_reasons (reason, report_id);

CREATE TABLE IF NOT EXISTS party_bans (
  id TEXT PRIMARY KEY,
  name TEXT,
  username TEXT,
  reason TEXT,
  banned_by TEXT NOT NULL,
  banned_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS party_bans_at ON party_bans (banned_at);

CREATE TABLE IF NOT EXISTS party_ban_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  by_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS party_ban_log_user ON party_ban_log (user_id, at);
CREATE INDEX IF NOT EXISTS party_reports_drawer ON party_reports (drawer_id, created);
CREATE INDEX IF NOT EXISTS party_reports_flag ON party_reports (status, created, drawer_id, reporter_id, game, ip_hash);

CREATE TABLE IF NOT EXISTS party_mod_notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  text TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS party_mod_notes_user ON party_mod_notes (user_id, created);

CREATE TABLE IF NOT EXISTS party_ban_terms (
  user_id TEXT PRIMARY KEY,
  until INTEGER NOT NULL,
  duration TEXT NOT NULL,
  set_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS party_ban_terms_until ON party_ban_terms (until);

CREATE TABLE IF NOT EXISTS party_warnings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  text TEXT NOT NULL,
  created INTEGER NOT NULL,
  seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS party_warnings_user ON party_warnings (user_id, created);
CREATE INDEX IF NOT EXISTS party_warnings_created ON party_warnings (created);

CREATE TABLE IF NOT EXISTS party_mod_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  target_name TEXT,
  detail TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS party_mod_log_created ON party_mod_log (created, id);
CREATE INDEX IF NOT EXISTS party_mod_log_actor ON party_mod_log (actor_id, created);
CREATE INDEX IF NOT EXISTS party_mod_log_action ON party_mod_log (action, created);
CREATE INDEX IF NOT EXISTS party_mod_log_target ON party_mod_log (target_id, action, created);

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

CREATE TABLE IF NOT EXISTS party_win_streaks (
  user_id TEXT PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS party_shards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  shards INTEGER NOT NULL,
  reason TEXT NOT NULL,
  game TEXT NOT NULL,
  at INTEGER NOT NULL,
  day TEXT NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS party_shards_claimed ON party_shards (claimed, at, id);
CREATE INDEX IF NOT EXISTS party_shards_user_day ON party_shards (user_id, day);

CREATE TABLE IF NOT EXISTS party_rates (
  id TEXT PRIMARY KEY,
  play INTEGER NOT NULL,
  win INTEGER NOT NULL,
  tournament INTEGER NOT NULL,
  prediction INTEGER NOT NULL,
  cap INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS public_profiles (
  user_id TEXT PRIMARY KEY,
  username TEXT,
  username_key TEXT,
  name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 0,
  xp INTEGER NOT NULL DEFAULT 0,
  shards INTEGER,
  badges TEXT NOT NULL DEFAULT '[]',
  achievements TEXT NOT NULL DEFAULT '[]',
  season TEXT NOT NULL DEFAULT '[]',
  clan TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS public_profiles_username ON public_profiles (username_key);
CREATE INDEX IF NOT EXISTS public_profiles_updated ON public_profiles (updated);

CREATE TABLE IF NOT EXISTS profile_settings (
  user_id TEXT PRIMARY KEY,
  hidden INTEGER NOT NULL DEFAULT 0,
  show_shards INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL,
  given INTEGER NOT NULL DEFAULT 0,
  claimed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS profile_settings_claimed ON profile_settings (claimed, updated);

CREATE TABLE IF NOT EXISTS pack_public (
  code TEXT PRIMARY KEY,
  public INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  published INTEGER,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pack_public_listed ON pack_public (public, blocked, published);

CREATE TABLE IF NOT EXISTS pack_likes (
  code TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (code, user_id)
);
CREATE INDEX IF NOT EXISTS pack_likes_user ON pack_likes (user_id, at);

CREATE TABLE IF NOT EXISTS pack_reports (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  reporter_name TEXT,
  reason TEXT,
  created INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  dismissed_at INTEGER,
  dismissed_by TEXT
);
CREATE INDEX IF NOT EXISTS pack_reports_status ON pack_reports (status, created, id);
CREATE INDEX IF NOT EXISTS pack_reports_pair ON pack_reports (code, reporter_id, status);

CREATE TABLE IF NOT EXISTS season_history (
  month TEXT PRIMARY KEY,
  boards TEXT NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS server_stats (
  server_id TEXT NOT NULL,
  hour INTEGER NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  joins INTEGER NOT NULL DEFAULT 0,
  leaves INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL,
  PRIMARY KEY (server_id, hour)
);
CREATE INDEX IF NOT EXISTS server_stats_hour ON server_stats (hour);
CREATE INDEX IF NOT EXISTS pack_reports_reporter ON pack_reports (reporter_id, status);

CREATE TABLE IF NOT EXISTS owner_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT,
  ref TEXT,
  note TEXT,
  notify INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  sent_at INTEGER,
  result TEXT,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS owner_actions_user ON owner_actions (user_id, created);
CREATE INDEX IF NOT EXISTS owner_actions_status ON owner_actions (status, created, id);
CREATE INDEX IF NOT EXISTS owner_actions_created ON owner_actions (created);

CREATE TABLE IF NOT EXISTS owner_catalog (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_known (
  user_id TEXT PRIMARY KEY,
  shards INTEGER,
  level INTEGER,
  xp INTEGER,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS party_points (
  user_id TEXT PRIMARY KEY,
  name TEXT,
  username TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  best INTEGER NOT NULL DEFAULT 0,
  best_game TEXT,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS party_points_points ON party_points (points DESC, updated, user_id);
CREATE INDEX IF NOT EXISTS party_points_wins ON party_points (wins DESC, updated, user_id);
CREATE INDEX IF NOT EXISTS party_points_games ON party_points (games DESC, updated, user_id);
CREATE INDEX IF NOT EXISTS party_points_best ON party_points (best DESC, updated, user_id);

CREATE TABLE IF NOT EXISTS party_points_game (
  user_id TEXT NOT NULL,
  game TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  best INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, game)
);
CREATE INDEX IF NOT EXISTS party_points_game_points ON party_points_game (game, points DESC);
CREATE INDEX IF NOT EXISTS party_points_game_wins ON party_points_game (game, wins DESC);
CREATE INDEX IF NOT EXISTS party_points_game_games ON party_points_game (game, games DESC);
CREATE INDEX IF NOT EXISTS party_points_game_best ON party_points_game (game, best DESC);

CREATE TABLE IF NOT EXISTS party_points_day (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS party_points_day_day ON party_points_day (day);

CREATE TABLE IF NOT EXISTS party_games_day (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  games INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS party_games_day_day ON party_games_day (day);

CREATE TABLE IF NOT EXISTS party_points_month (
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  best INTEGER NOT NULL DEFAULT 0,
  best_game TEXT,
  updated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);
CREATE INDEX IF NOT EXISTS party_points_month_rank ON party_points_month (month, points DESC, updated, user_id);

CREATE TABLE IF NOT EXISTS party_season_awards (
  month TEXT NOT NULL,
  rank INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT,
  username TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  awarded INTEGER NOT NULL,
  PRIMARY KEY (month, rank)
);
CREATE INDEX IF NOT EXISTS party_season_awards_user ON party_season_awards (user_id, month);

CREATE TABLE IF NOT EXISTS party_board_hidden (
  user_id TEXT PRIMARY KEY,
  by_id TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS global_board_hidden (
  user_id TEXT PRIMARY KEY,
  by_id TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_links (
  code_hash TEXT PRIMARY KEY,
  poll_hash TEXT NOT NULL UNIQUE,
  expect TEXT,
  user_id TEXT,
  username TEXT,
  display_name TEXT,
  avatar_url TEXT,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  approved INTEGER
);
CREATE INDEX IF NOT EXISTS activity_links_expires ON activity_links (expires);

CREATE TABLE IF NOT EXISTS activity_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS activity_sessions_user ON activity_sessions (user_id);
CREATE INDEX IF NOT EXISTS activity_sessions_expires ON activity_sessions (expires);

CREATE TABLE IF NOT EXISTS party_blocked_words (
  id TEXT PRIMARY KEY,
  word TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  added_by TEXT NOT NULL,
  added_name TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS party_blocked_words_created ON party_blocked_words (created);

CREATE TABLE IF NOT EXISTS party_blocked_patterns (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL UNIQUE,
  added_by TEXT NOT NULL,
  added_name TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS party_blocked_patterns_created ON party_blocked_patterns (created);

CREATE TABLE IF NOT EXISTS party_cheat_alerts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  detail TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open',
  handled_by TEXT,
  handled_at INTEGER,
  UNIQUE (user_id, kind)
);
CREATE INDEX IF NOT EXISTS party_cheat_alerts_status ON party_cheat_alerts (status, last_at);

CREATE TABLE IF NOT EXISTS party_cheat_days (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, day)
);
CREATE INDEX IF NOT EXISTS party_cheat_days_day ON party_cheat_days (day);

CREATE TABLE IF NOT EXISTS party_cheat_pairs (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  day TEXT NOT NULL,
  games INTEGER NOT NULL DEFAULT 0,
  wins_a INTEGER NOT NULL DEFAULT 0,
  wins_b INTEGER NOT NULL DEFAULT 0,
  fast INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (a, b, day)
);
CREATE INDEX IF NOT EXISTS party_cheat_pairs_day ON party_cheat_pairs (day);

CREATE TABLE IF NOT EXISTS custom_badges (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  note TEXT,
  emoji TEXT NOT NULL,
  image BLOB NOT NULL,
  mime TEXT NOT NULL,
  hash TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS custom_badges_created ON custom_badges (created);
CREATE TABLE IF NOT EXISTS profile_custom (
  user_id TEXT PRIMARY KEY,
  v INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS profile_banners (
  user_id TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  image BLOB NOT NULL,
  mime TEXT NOT NULL,
  hash TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS party_hidden_names (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT,
  by_id TEXT NOT NULL,
  by_name TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);
CREATE INDEX IF NOT EXISTS party_hidden_names_at ON party_hidden_names (at);
CREATE TABLE IF NOT EXISTS profile_banner_stills (
  user_id TEXT PRIMARY KEY,
  banner_hash TEXT NOT NULL,
  image BLOB NOT NULL,
  mime TEXT NOT NULL,
  hash TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clan_directory (
  id TEXT PRIMARY KEY,
  tag TEXT NOT NULL,
  tag_key TEXT NOT NULL,
  name TEXT NOT NULL,
  colour TEXT,
  banner TEXT,
  members INTEGER NOT NULL DEFAULT 0,
  join_mode TEXT NOT NULL DEFAULT 'open',
  leader_id TEXT,
  created INTEGER,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clan_directory_tag ON clan_directory (tag_key, updated);

CREATE TABLE IF NOT EXISTS clan_members (
  user_id TEXT PRIMARY KEY,
  clan_id TEXT NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clan_members_clan ON clan_members (clan_id);

CREATE TABLE IF NOT EXISTS clan_joins (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  clan_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  via TEXT,
  created INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  sent_at INTEGER,
  code TEXT,
  result TEXT,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clan_joins_user ON clan_joins (user_id, status, created);
CREATE INDEX IF NOT EXISTS clan_joins_status ON clan_joins (status, created);

CREATE TABLE IF NOT EXISTS clan_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  clan_id TEXT,
  payload TEXT,
  created INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  sent_at INTEGER,
  code TEXT,
  result TEXT,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clan_actions_user ON clan_actions (user_id, status, created);
CREATE INDEX IF NOT EXISTS clan_actions_status ON clan_actions (status, created);

CREATE TABLE IF NOT EXISTS clan_details (
  clan_id TEXT PRIMARY KEY,
  bank INTEGER NOT NULL DEFAULT 0,
  style INTEGER NOT NULL DEFAULT 0,
  boost INTEGER NOT NULL DEFAULT 0,
  deposits TEXT,
  joined TEXT,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clan_invites (
  user_id TEXT NOT NULL,
  clan_id TEXT NOT NULL,
  by_id TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, clan_id)
);
CREATE INDEX IF NOT EXISTS clan_invites_clan ON clan_invites (clan_id);

CREATE TABLE IF NOT EXISTS clan_sync (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL DEFAULT 0,
  data TEXT,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  data TEXT,
  created INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, created);
CREATE INDEX IF NOT EXISTS notifications_created ON notifications (created);

CREATE TABLE IF NOT EXISTS profile_avatars (
  user_id TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  image BLOB NOT NULL,
  mime TEXT NOT NULL,
  hash TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  frames INTEGER NOT NULL DEFAULT 1,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_avatar_stills (
  user_id TEXT PRIMARY KEY,
  avatar_hash TEXT NOT NULL,
  image BLOB NOT NULL,
  mime TEXT NOT NULL,
  hash TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_avatar_cutouts (
  user_id TEXT PRIMARY KEY,
  avatar_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  backdrop TEXT NOT NULL DEFAULT 'theme',
  original BLOB,
  original_mime TEXT,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_likes (
  liker_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (liker_id, target_id)
);
CREATE INDEX IF NOT EXISTS profile_likes_target ON profile_likes (target_id, at);

CREATE TABLE IF NOT EXISTS profile_like_pings (
  liker_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (liker_id, target_id)
);
CREATE INDEX IF NOT EXISTS profile_like_pings_at ON profile_like_pings (at);
