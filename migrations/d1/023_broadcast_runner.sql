ALTER TABLE broadcast_campaigns ADD COLUMN next_runner_at TEXT NOT NULL DEFAULT '';
CREATE INDEX broadcast_runner_due ON broadcast_campaigns(status,next_runner_at,scheduled_at);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(23);
