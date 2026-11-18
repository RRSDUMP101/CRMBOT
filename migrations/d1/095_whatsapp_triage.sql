CREATE TABLE whatsapp_triage_settings (
 org_id TEXT PRIMARY KEY REFERENCES organizations(id),
 mode TEXT NOT NULL CHECK(mode IN ('shadow','enforce')),
 repeat_limit INTEGER NOT NULL CHECK(repeat_limit BETWEEN 2 AND 100),
 window_seconds INTEGER NOT NULL CHECK(window_seconds BETWEEN 10 AND 3600),
 revision INTEGER NOT NULL
);
CREATE TABLE whatsapp_triage (
 org_id TEXT NOT NULL, message_id TEXT NOT NULL, conversation_id TEXT NOT NULL, identity_id TEXT NOT NULL,
 event_id TEXT NOT NULL, source_seq INTEGER NOT NULL, source_version INTEGER NOT NULL, fresh INTEGER NOT NULL,
 category TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, mode TEXT NOT NULL, policy_version TEXT NOT NULL,
 fingerprint TEXT NOT NULL, received_ms INTEGER NOT NULL, eligible INTEGER NOT NULL,
 review_state TEXT NOT NULL CHECK(review_state IN ('clear','pending','held','released','suppressed')),
 revision INTEGER NOT NULL DEFAULT 1, reviewed_by TEXT, reviewed_at TEXT,
 semantic_status TEXT NOT NULL DEFAULT 'none' CHECK(semantic_status IN ('none','pending','working','suggested','unavailable','stale')),
 semantic_token TEXT, semantic_until INTEGER, semantic_suggestion TEXT,
 PRIMARY KEY(org_id,message_id),
 FOREIGN KEY(org_id,message_id) REFERENCES messages(org_id,id),
 FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id),
 FOREIGN KEY(org_id,identity_id) REFERENCES social_identities(org_id,id)
);
CREATE INDEX whatsapp_triage_sender_time ON whatsapp_triage(org_id,identity_id,received_ms);
CREATE INDEX whatsapp_triage_checkpoint ON whatsapp_triage(org_id,identity_id,source_seq);
CREATE INDEX whatsapp_triage_review ON whatsapp_triage(org_id,review_state,received_ms);
CREATE INDEX whatsapp_triage_pending_ai ON whatsapp_triage(org_id,semantic_status,received_ms);
CREATE TABLE whatsapp_triage_suppressions (
 org_id TEXT NOT NULL, identity_id TEXT NOT NULL, message_id TEXT NOT NULL,
 PRIMARY KEY(org_id,identity_id),
 FOREIGN KEY(org_id,message_id) REFERENCES whatsapp_triage(org_id,message_id)
);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(95);
