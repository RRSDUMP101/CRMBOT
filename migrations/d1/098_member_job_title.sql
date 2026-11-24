ALTER TABLE members ADD COLUMN job_title TEXT;
INSERT OR IGNORE INTO schema_migrations(version) VALUES(98);
