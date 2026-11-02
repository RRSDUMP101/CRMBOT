CREATE TABLE crm_automation_health(
 org_id TEXT NOT NULL REFERENCES organizations(id),worker TEXT NOT NULL,last_run_at INTEGER NOT NULL,
 last_success_at INTEGER,status TEXT NOT NULL,runs INTEGER NOT NULL DEFAULT 1,details TEXT NOT NULL DEFAULT '{}',
 PRIMARY KEY(org_id,worker)
);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(36);
