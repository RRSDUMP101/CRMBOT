-- Additive, explicit operator import only. No provider work is enqueued.
CREATE TABLE crm_legacy_snapshots (
 org_id TEXT NOT NULL REFERENCES organizations(id), source_system TEXT NOT NULL, workspace TEXT NOT NULL,
 snapshot_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot_hash TEXT NOT NULL, plan_hash TEXT NOT NULL,
 cursor INTEGER NOT NULL DEFAULT 0, total_units INTEGER NOT NULL, source_record_count INTEGER NOT NULL,
 source_webhook_count INTEGER NOT NULL, source_auxiliary_count INTEGER NOT NULL DEFAULT 0, source_tail_sequence INTEGER,
 status TEXT NOT NULL DEFAULT 'importing' CHECK(status IN ('importing','complete')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'), completed_at TEXT,
 PRIMARY KEY(org_id,workspace,snapshot_id)
);
CREATE TABLE crm_legacy_records (
 org_id TEXT NOT NULL, workspace TEXT NOT NULL, snapshot_id TEXT NOT NULL,
 source_id TEXT NOT NULL, kind TEXT NOT NULL, content_hash TEXT NOT NULL, raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
 PRIMARY KEY(org_id,workspace,snapshot_id,source_id),
 FOREIGN KEY(org_id,workspace,snapshot_id) REFERENCES crm_legacy_snapshots(org_id,workspace,snapshot_id)
);
CREATE TABLE crm_legacy_webhooks (
 org_id TEXT NOT NULL, workspace TEXT NOT NULL, snapshot_id TEXT NOT NULL, id TEXT NOT NULL, time TEXT NOT NULL,
 PRIMARY KEY(org_id,workspace,snapshot_id,id),
 FOREIGN KEY(org_id,workspace,snapshot_id) REFERENCES crm_legacy_snapshots(org_id,workspace,snapshot_id)
);
CREATE INDEX crm_legacy_webhook_lookup ON crm_legacy_webhooks(org_id,workspace,id);
CREATE TABLE crm_legacy_auxiliary (
 org_id TEXT NOT NULL, workspace TEXT NOT NULL, snapshot_id TEXT NOT NULL, source_table TEXT NOT NULL, source_id TEXT NOT NULL,
 content_hash TEXT NOT NULL, raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
 PRIMARY KEY(org_id,workspace,snapshot_id,source_table,source_id),
 FOREIGN KEY(org_id,workspace,snapshot_id) REFERENCES crm_legacy_snapshots(org_id,workspace,snapshot_id)
);
CREATE TABLE crm_legacy_auxiliary_heads (
 org_id TEXT NOT NULL REFERENCES organizations(id), workspace TEXT NOT NULL, source_table TEXT NOT NULL, source_id TEXT NOT NULL,
 content_hash TEXT NOT NULL, source_tail_sequence INTEGER, snapshot_id TEXT NOT NULL,
 PRIMARY KEY(org_id,workspace,source_table,source_id)
);
CREATE TABLE crm_legacy_source_heads (
 org_id TEXT NOT NULL REFERENCES organizations(id), workspace TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL,
 target_id TEXT NOT NULL, content_hash TEXT NOT NULL, source_revision INTEGER NOT NULL, source_updated TEXT NOT NULL,
 snapshot_id TEXT NOT NULL, PRIMARY KEY(org_id,workspace,kind,source_id)
);
CREATE TABLE crm_legacy_target_baselines (
 org_id TEXT NOT NULL REFERENCES organizations(id), workspace TEXT NOT NULL, entity TEXT NOT NULL, target_id TEXT NOT NULL,
 source_json TEXT NOT NULL CHECK(json_valid(source_json)), owned_fields TEXT NOT NULL CHECK(json_valid(owned_fields)),
 source_revision INTEGER NOT NULL, snapshot_id TEXT NOT NULL,
 PRIMARY KEY(org_id,workspace,entity,target_id)
);
CREATE TRIGGER crm_legacy_records_immutable BEFORE UPDATE ON crm_legacy_records BEGIN SELECT RAISE(ABORT,'Legacy records are immutable'); END;
CREATE TRIGGER crm_legacy_webhooks_immutable BEFORE UPDATE ON crm_legacy_webhooks BEGIN SELECT RAISE(ABORT,'Legacy webhook records are immutable'); END;
CREATE TRIGGER crm_legacy_records_no_delete BEFORE DELETE ON crm_legacy_records BEGIN SELECT RAISE(ABORT,'Legacy records are immutable'); END;
CREATE TRIGGER crm_legacy_webhooks_no_delete BEFORE DELETE ON crm_legacy_webhooks BEGIN SELECT RAISE(ABORT,'Legacy webhook records are immutable'); END;
CREATE TRIGGER crm_legacy_auxiliary_immutable BEFORE UPDATE ON crm_legacy_auxiliary BEGIN SELECT RAISE(ABORT,'Legacy auxiliary records are immutable'); END;
CREATE TRIGGER crm_legacy_auxiliary_no_delete BEFORE DELETE ON crm_legacy_auxiliary BEGIN SELECT RAISE(ABORT,'Legacy auxiliary records are immutable'); END;
INSERT OR IGNORE INTO schema_migrations(version) VALUES(7);
