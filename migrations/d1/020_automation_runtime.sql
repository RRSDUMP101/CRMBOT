-- Durable ingress receipt. Execution keys remain the final exactly-once action guard.
CREATE TABLE flow_ingress (
 org_id TEXT NOT NULL, event_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 signal TEXT NOT NULL CHECK(json_valid(signal)), targets TEXT NOT NULL CHECK(json_valid(targets)),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processed','failed')),
 attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, retry_at TEXT NOT NULL, processed_at TEXT,
 PRIMARY KEY(org_id,event_id),
 FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id)
);
CREATE INDEX flow_ingress_pending ON flow_ingress(status,retry_at,created_at);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(20);
