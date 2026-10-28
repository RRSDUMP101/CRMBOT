CREATE TABLE attachments (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), lead_id TEXT NOT NULL,
 uploaded_by TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, filename TEXT NOT NULL,
 content_type TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes>0 AND size_bytes<=10485760),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
 FOREIGN KEY(org_id,lead_id) REFERENCES leads(org_id,id),
 FOREIGN KEY(org_id,uploaded_by) REFERENCES members(org_id,id)
);
CREATE INDEX attachments_lead_idx ON attachments(org_id,lead_id,created_at DESC);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(4);
