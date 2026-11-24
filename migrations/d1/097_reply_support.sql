CREATE TABLE IF NOT EXISTS reply_template_revisions (
  org_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  title TEXT NOT NULL,
  shortcut TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(org_id,template_id,version),
  FOREIGN KEY(org_id,template_id) REFERENCES reply_templates(org_id,id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS desk_send_issues (
  org_id TEXT NOT NULL REFERENCES organizations(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  client_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('reply','note')),
  status INTEGER NOT NULL CHECK(status BETWEEN 400 AND 599),
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,member_id,client_id)
);

INSERT OR IGNORE INTO schema_migrations(version) VALUES(97);
