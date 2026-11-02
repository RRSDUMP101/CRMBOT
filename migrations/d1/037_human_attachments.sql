CREATE TABLE human_attachments (
 id TEXT PRIMARY KEY,org_id TEXT NOT NULL,conversation_id TEXT NOT NULL,uploaded_by TEXT NOT NULL,
 provider TEXT NOT NULL,account_id TEXT NOT NULL,conversation_version INTEGER NOT NULL,customer_seq INTEGER NOT NULL,
 filename TEXT NOT NULL,content_type TEXT NOT NULL,size_bytes INTEGER NOT NULL CHECK(size_bytes>0),sha256 TEXT NOT NULL,object_key TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','approved','deleting')),
 client_id TEXT,message_id TEXT,outbound_command_id TEXT,provider_media_id TEXT,
 grant_hash TEXT,grant_expires_at TEXT,grant_attempt TEXT,grant_fingerprint TEXT,grant_epoch INTEGER,grant_reads INTEGER NOT NULL DEFAULT 0,
 expires_at TEXT NOT NULL,created_at TEXT NOT NULL,
 UNIQUE(org_id,id),UNIQUE(org_id,client_id),UNIQUE(org_id,message_id),UNIQUE(org_id,outbound_command_id),
 FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id),
 FOREIGN KEY(org_id,uploaded_by) REFERENCES members(org_id,id)
);
CREATE INDEX human_attachments_actor ON human_attachments(org_id,conversation_id,uploaded_by,status,expires_at);
CREATE UNIQUE INDEX human_attachment_grants ON human_attachments(grant_hash) WHERE grant_hash IS NOT NULL;
INSERT OR IGNORE INTO schema_migrations(version) VALUES(37);
