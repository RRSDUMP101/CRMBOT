-- Native inbound WhatsApp media only. Imports never enqueue provider work.
CREATE UNIQUE INDEX social_attachment_org_id ON social_message_attachments(org_id,id);
CREATE TABLE social_media_archive_jobs (
 org_id TEXT NOT NULL,attachment_id TEXT NOT NULL,account_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','working','retry','blocked','archived','failed','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),next_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK(next_attempt_at>=0),
 lease_until INTEGER NOT NULL DEFAULT 0,lease_token TEXT NOT NULL DEFAULT '',error_code TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(org_id,attachment_id),
 FOREIGN KEY(org_id,attachment_id) REFERENCES social_message_attachments(org_id,id)
);
CREATE INDEX social_media_archive_due ON social_media_archive_jobs(org_id,status,next_attempt_at);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(14);
