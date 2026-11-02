ALTER TABLE knowledge ADD COLUMN scope_json TEXT NOT NULL DEFAULT '["*"]' CHECK(json_valid(scope_json));
ALTER TABLE knowledge ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE knowledge ADD COLUMN reviewed_version INTEGER;
ALTER TABLE knowledge ADD COLUMN reviewed_by TEXT;
ALTER TABLE knowledge ADD COLUMN reviewed_at TEXT;
UPDATE knowledge SET reviewed_version=version WHERE status='published';
CREATE TABLE knowledge_versions (
 org_id TEXT NOT NULL, source_id TEXT NOT NULL, version INTEGER NOT NULL,
 title TEXT NOT NULL, content TEXT NOT NULL, scope_json TEXT NOT NULL, source_url TEXT,
 source_type TEXT NOT NULL, expires_at TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,source_id,version)
);
INSERT INTO knowledge_versions SELECT org_id,id,version,title,content,scope_json,source_url,source_type,expires_at,'legacy-published-state',updated_at FROM knowledge;
CREATE TRIGGER knowledge_version_immutable BEFORE UPDATE ON knowledge_versions BEGIN SELECT RAISE(ABORT,'knowledge_version_immutable'); END;
CREATE TABLE ai_profiles (
 org_id TEXT NOT NULL, scope TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 personality TEXT NOT NULL DEFAULT '', scenarios TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(scenarios)),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused')),
 source_fingerprint TEXT NOT NULL DEFAULT '', active_evaluation_id TEXT, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(org_id,scope)
);
CREATE TABLE ai_evaluations (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, scope TEXT NOT NULL, revision INTEGER NOT NULL,
 source_fingerprint TEXT NOT NULL, prompt TEXT NOT NULL, answer TEXT NOT NULL, citations TEXT NOT NULL CHECK(json_valid(citations)),
 handoff INTEGER NOT NULL, passed INTEGER NOT NULL, error_code TEXT NOT NULL DEFAULT '',
 created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX ai_evaluations_scope ON ai_evaluations(org_id,scope,created_at);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(21);
