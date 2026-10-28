CREATE TABLE social_media_archive (
 org_id TEXT NOT NULL, attachment_id TEXT NOT NULL, object_key TEXT NOT NULL,
 size_bytes INTEGER NOT NULL CHECK(size_bytes>0), content_type TEXT NOT NULL, sha256 TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','ready')), created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,attachment_id),
 FOREIGN KEY(attachment_id) REFERENCES social_message_attachments(id)
);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(8);
