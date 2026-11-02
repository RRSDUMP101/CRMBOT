ALTER TABLE messages ADD COLUMN author_member_id TEXT;
ALTER TABLE messages ADD COLUMN author_type TEXT NOT NULL DEFAULT 'unknown' CHECK(author_type IN ('human','automation','unknown'));
CREATE INDEX messages_author_time ON messages(org_id,author_member_id,created_at);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(22);
