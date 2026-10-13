-- Website telemetry is separate from sleep/account/financial records.
CREATE TABLE IF NOT EXISTS monitor_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO monitor_meta VALUES ('started_at', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE IF NOT EXISTS web_visits (
  id TEXT PRIMARY KEY, visitor TEXT NOT NULL, session TEXT NOT NULL,
  started_at TEXT NOT NULL, last_seen TEXT NOT NULL, host TEXT NOT NULL,
  path TEXT NOT NULL, language TEXT NOT NULL, referrer TEXT NOT NULL,
  source TEXT NOT NULL, medium TEXT NOT NULL, campaign TEXT NOT NULL,
  country TEXT NOT NULL, region TEXT NOT NULL, city TEXT NOT NULL, network TEXT NOT NULL,
  browser TEXT NOT NULL, os TEXT NOT NULL, device TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0, scroll INTEGER NOT NULL DEFAULT 0,
  lcp_ms REAL, cls REAL, inp_ms REAL, ttfb_ms REAL,
  bot INTEGER NOT NULL DEFAULT 0, test INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_web_visits_started ON web_visits(started_at);
CREATE INDEX IF NOT EXISTS idx_web_visits_session ON web_visits(session, started_at);
CREATE TABLE IF NOT EXISTS web_events (
  id TEXT PRIMARY KEY, visit_id TEXT NOT NULL REFERENCES web_visits(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, value REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_web_events_created ON web_events(created_at);
CREATE INDEX IF NOT EXISTS idx_web_events_visit ON web_events(visit_id);
CREATE TABLE IF NOT EXISTS request_metrics (
  minute TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, method TEXT NOT NULL,
  status INTEGER NOT NULL, bot INTEGER NOT NULL, test INTEGER NOT NULL,
  requests INTEGER NOT NULL DEFAULT 1, total_ms REAL NOT NULL, max_ms REAL NOT NULL,
  PRIMARY KEY (minute, host, path, method, status, bot, test)
);
CREATE TABLE IF NOT EXISTS health_checks (
  id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL, target TEXT NOT NULL,
  ok INTEGER NOT NULL, status INTEGER NOT NULL, latency_ms REAL NOT NULL,
  detail TEXT NOT NULL, trigger TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_health_checks_time ON health_checks(checked_at);
CREATE TABLE IF NOT EXISTS monitor_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at TEXT NOT NULL);
