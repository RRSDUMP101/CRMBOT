CREATE TABLE wa_template_drafts(
 id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),account_id TEXT NOT NULL,
 name TEXT NOT NULL,language TEXT NOT NULL,category TEXT NOT NULL CHECK(category IN ('UTILITY','MARKETING')),
 body TEXT NOT NULL,examples TEXT NOT NULL DEFAULT '[]',revision INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'draft',provider_id TEXT,provider_status TEXT,provider_reason TEXT,
 attempt_id TEXT,created_by TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(org_id,account_id,name,language)
);
CREATE INDEX wa_template_scope ON wa_template_drafts(org_id,account_id,updated_at);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(33);
