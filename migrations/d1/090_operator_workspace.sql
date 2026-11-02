-- Additive operator workspace. Existing conversation, message and identity keys remain intact.
CREATE TABLE operator_views (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL,
 visibility TEXT NOT NULL CHECK(visibility IN ('personal','organization')), filters_json TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, UNIQUE(org_id,id),
 FOREIGN KEY(org_id,owner_id) REFERENCES members(org_id,id)
);
CREATE TABLE operator_drafts (
 org_id TEXT NOT NULL, conversation_id TEXT NOT NULL, member_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('reply','note')), content TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
 PRIMARY KEY(org_id,conversation_id,member_id,kind),
 FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id), FOREIGN KEY(org_id,member_id) REFERENCES members(org_id,id)
);
CREATE TABLE operator_presence (
 org_id TEXT NOT NULL, conversation_id TEXT NOT NULL, member_id TEXT NOT NULL,
 typing INTEGER NOT NULL CHECK(typing IN (0,1)), expires_at TEXT NOT NULL,
 PRIMARY KEY(org_id,conversation_id,member_id),
 FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id), FOREIGN KEY(org_id,member_id) REFERENCES members(org_id,id)
);
CREATE TABLE operator_mentions (
 org_id TEXT NOT NULL, message_id TEXT NOT NULL, member_id TEXT NOT NULL, seen_at TEXT,
 PRIMARY KEY(org_id,message_id,member_id), FOREIGN KEY(org_id,message_id) REFERENCES messages(org_id,id), FOREIGN KEY(org_id,member_id) REFERENCES members(org_id,id)
);
CREATE TABLE operator_note_requests (
 org_id TEXT NOT NULL, member_id TEXT NOT NULL, client_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
 PRIMARY KEY(org_id,member_id,client_id), FOREIGN KEY(org_id,message_id) REFERENCES messages(org_id,id)
);
CREATE TABLE operator_contact_links (
 org_id TEXT NOT NULL, source_lead_id TEXT NOT NULL, canonical_lead_id TEXT NOT NULL, actor_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,source_lead_id), CHECK(source_lead_id<>canonical_lead_id),
 FOREIGN KEY(org_id,source_lead_id) REFERENCES leads(org_id,id), FOREIGN KEY(org_id,canonical_lead_id) REFERENCES leads(org_id,id), FOREIGN KEY(org_id,actor_id) REFERENCES members(org_id,id)
);
CREATE TABLE operator_contact_identities (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, lead_id TEXT NOT NULL, provider TEXT NOT NULL, account_id TEXT NOT NULL, remote_id TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(org_id,provider,account_id,remote_id), FOREIGN KEY(org_id,lead_id) REFERENCES leads(org_id,id)
);
CREATE TABLE operator_field_definitions (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL,
 target TEXT NOT NULL CHECK(target IN ('contact','ticket')), field_type TEXT NOT NULL CHECK(field_type IN ('text','number','boolean','date','select')),
 options_json TEXT NOT NULL DEFAULT '[]', market TEXT NOT NULL CHECK(market IN ('all','unknown','domestic','export')),
 required_on_close INTEGER NOT NULL DEFAULT 0 CHECK(required_on_close IN (0,1)), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), version INTEGER NOT NULL DEFAULT 1,
 UNIQUE(org_id,id), UNIQUE(org_id,target,name)
);
CREATE TABLE operator_field_values (
 org_id TEXT NOT NULL, field_id TEXT NOT NULL, entity_id TEXT NOT NULL, value_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(org_id,field_id,entity_id), FOREIGN KEY(org_id,field_id) REFERENCES operator_field_definitions(org_id,id)
);
CREATE TABLE operator_teams (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, timezone TEXT NOT NULL,
 hours_json TEXT NOT NULL DEFAULT '[]', market TEXT NOT NULL CHECK(market IN ('all','unknown','domestic','export')),
 provider TEXT NOT NULL DEFAULT '', account_id TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 priority INTEGER NOT NULL DEFAULT 100, rotation INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, UNIQUE(org_id,id), UNIQUE(org_id,name)
);
CREATE TABLE operator_team_members (
 org_id TEXT NOT NULL, team_id TEXT NOT NULL, member_id TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity BETWEEN 0 AND 100),
 available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1)), leave_start TEXT, leave_end TEXT, last_assignment INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(org_id,team_id,member_id), FOREIGN KEY(org_id,team_id) REFERENCES operator_teams(org_id,id), FOREIGN KEY(org_id,member_id) REFERENCES members(org_id,id)
);
CREATE TABLE operator_templates (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, owner_id TEXT NOT NULL, title TEXT NOT NULL, shortcut TEXT NOT NULL,
 content TEXT NOT NULL, category TEXT NOT NULL, visibility TEXT NOT NULL CHECK(visibility IN ('personal','team','organization')), team_id TEXT,
 asset_id TEXT, version INTEGER NOT NULL DEFAULT 1, UNIQUE(org_id,id), UNIQUE(org_id,owner_id,shortcut),
 FOREIGN KEY(org_id,owner_id) REFERENCES members(org_id,id), FOREIGN KEY(org_id,team_id) REFERENCES operator_teams(org_id,id)
);
CREATE TABLE operator_assets (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, owner_id TEXT NOT NULL, filename TEXT NOT NULL, content_type TEXT NOT NULL,
 size_bytes INTEGER NOT NULL CHECK(size_bytes>0 AND size_bytes<=10485760), object_key TEXT NOT NULL UNIQUE,
 visibility TEXT NOT NULL CHECK(visibility IN ('personal','team','organization')), team_id TEXT, status TEXT NOT NULL CHECK(status IN ('pending','ready')),
 UNIQUE(org_id,id), FOREIGN KEY(org_id,owner_id) REFERENCES members(org_id,id), FOREIGN KEY(org_id,team_id) REFERENCES operator_teams(org_id,id)
);
CREATE INDEX operator_presence_expiry ON operator_presence(org_id,conversation_id,expires_at);
CREATE INDEX operator_mentions_member ON operator_mentions(org_id,member_id,seen_at);
CREATE INDEX operator_contact_canonical ON operator_contact_links(org_id,canonical_lead_id);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(90);
