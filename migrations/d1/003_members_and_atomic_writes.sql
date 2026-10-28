ALTER TABLE members ADD COLUMN username TEXT CHECK(username IS NULL OR (length(username) BETWEEN 3 AND 64 AND username=lower(username) AND username NOT GLOB '*[^a-z0-9_.-]*' AND substr(username,1,1) GLOB '[a-z0-9]'));
CREATE UNIQUE INDEX members_username_unique_idx ON members(username) WHERE username IS NOT NULL;
ALTER TABLE organizations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE crm_tx_guard(token TEXT PRIMARY KEY, ok INTEGER NOT NULL CONSTRAINT rrs_cas_guard CHECK(ok=1));
CREATE UNIQUE INDEX one_appointment_draft ON tasks(org_id,visitor_conversation_id) WHERE kind='appointment' AND status='draft';
CREATE UNIQUE INDEX one_assistant_generation ON messages(org_id,conversation_id,reply_to_client_id,generation_version) WHERE role='assistant';
INSERT OR IGNORE INTO schema_migrations(version) VALUES(3);
