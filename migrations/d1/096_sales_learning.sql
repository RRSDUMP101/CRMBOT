CREATE TABLE sales_learning_receipts(org_id TEXT NOT NULL,command_id TEXT NOT NULL,payload_hash TEXT NOT NULL,run_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(org_id,command_id));
INSERT OR IGNORE INTO schema_migrations(version) VALUES(96);
