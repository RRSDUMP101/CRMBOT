CREATE TABLE sales_setting_undo (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('botName','replyTemplate')),
  entity_id TEXT NOT NULL,
  previous_value TEXT NOT NULL CHECK(json_valid(previous_value)),
  PRIMARY KEY(org_id,kind,entity_id)
);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(97);
