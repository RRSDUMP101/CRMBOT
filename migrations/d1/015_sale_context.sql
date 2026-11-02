-- Read-only projection of Sale Office deal context (statuses and counts, no prices).
-- Sale owns these facts; CRM never edits them. Rebuildable from the Sale outbox.
CREATE TABLE crm_sale_context (
 org_id TEXT NOT NULL REFERENCES organizations(id), deal_id TEXT NOT NULL, lead_id TEXT NOT NULL,
 workspace TEXT NOT NULL CHECK(workspace IN ('live','domestic')),
 aggregate_version INTEGER NOT NULL, sale_sequence INTEGER NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload)), updated_at TEXT NOT NULL,
 PRIMARY KEY(org_id,deal_id)
);
CREATE INDEX crm_sale_context_lead_idx ON crm_sale_context(org_id,lead_id);
CREATE TABLE crm_sale_context_events (
 org_id TEXT NOT NULL, event_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload_hash TEXT NOT NULL, received_at TEXT NOT NULL,
 PRIMARY KEY(org_id,event_id), UNIQUE(org_id,sequence)
);
CREATE TABLE crm_sale_context_cursor (
 org_id TEXT PRIMARY KEY NOT NULL, last_sequence INTEGER NOT NULL DEFAULT 0, acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
 token TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '', last_success_at TEXT, updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(15);
