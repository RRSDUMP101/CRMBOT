CREATE TABLE sales_knowledge_scope (
 org_id TEXT NOT NULL, source_id TEXT NOT NULL, version INTEGER NOT NULL,
 applicability TEXT NOT NULL CHECK(json_valid(applicability)), evidence_message_id TEXT,
 PRIMARY KEY(org_id,source_id,version)
);
CREATE TABLE sales_customer_facts (
 org_id TEXT NOT NULL, conversation_id TEXT NOT NULL, fact_key TEXT NOT NULL, revision INTEGER NOT NULL,
 value TEXT, unit TEXT, state TEXT NOT NULL CHECK(state IN ('customer_reported','confirmed','unknown')),
 source_message_id TEXT NOT NULL, reviewer_id TEXT, created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,conversation_id,fact_key,revision),
 UNIQUE(org_id,conversation_id,source_message_id,fact_key,state,revision)
);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(94);
