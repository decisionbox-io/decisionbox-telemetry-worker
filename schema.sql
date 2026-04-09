-- DecisionBox Telemetry — D1 Schema
-- Apply with: wrangler d1 execute decisionbox-telemetry --file=schema.sql

CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    install_id      TEXT NOT NULL,
    version         TEXT NOT NULL DEFAULT '',
    go_version      TEXT NOT NULL DEFAULT '',
    os              TEXT NOT NULL DEFAULT '',
    arch            TEXT NOT NULL DEFAULT '',
    service         TEXT NOT NULL DEFAULT '',
    event_name      TEXT NOT NULL,
    properties      TEXT,  -- JSON
    event_timestamp TEXT NOT NULL,
    received_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Query patterns: by event name, by install, by time range
CREATE INDEX IF NOT EXISTS idx_events_name ON events (event_name);
CREATE INDEX IF NOT EXISTS idx_events_install ON events (install_id);
CREATE INDEX IF NOT EXISTS idx_events_received ON events (received_at);
