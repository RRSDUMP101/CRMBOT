ALTER TABLE messages ADD COLUMN source_owner_only INTEGER NOT NULL DEFAULT 0 CHECK(source_owner_only IN (0,1));
-- Changes and their sequence commit atomically with the owning D1 row.
-- JSON-valued business columns remain JSON strings inside record_json.
-- The log is retained after ACK; no deletion/retention task is enabled here.
CREATE TABLE crm_bridge_state (
 org_id TEXT PRIMARY KEY REFERENCES organizations(id), sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence>=0)
);
CREATE TABLE crm_bridge_events (
 org_id TEXT NOT NULL REFERENCES organizations(id), sequence INTEGER NOT NULL CHECK(sequence>0),
 event_id TEXT NOT NULL UNIQUE, entity TEXT NOT NULL CHECK(entity IN ('lead','conversation','message','socialIdentity','messageProvenance','attachment')),
 record_id TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
 PRIMARY KEY(org_id,sequence)
);
CREATE TABLE crm_bridge_entities (
 org_id TEXT NOT NULL REFERENCES organizations(id), entity TEXT NOT NULL CHECK(entity IN ('lead','conversation','message','socialIdentity','messageProvenance','attachment')), record_id TEXT NOT NULL,
 PRIMARY KEY(org_id,entity,record_id)
);
CREATE TABLE crm_bridge_bootstrap_items (
 org_id TEXT NOT NULL REFERENCES organizations(id), entity TEXT NOT NULL CHECK(entity IN ('lead','conversation','message','socialIdentity','messageProvenance','attachment')), record_id TEXT NOT NULL,
 PRIMARY KEY(org_id,entity,record_id)
);
CREATE TABLE crm_bridge_consumers (
 org_id TEXT NOT NULL REFERENCES organizations(id), consumer_id TEXT NOT NULL, acknowledged_sequence INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged_sequence>=0),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
 PRIMARY KEY(org_id,consumer_id)
);
CREATE TABLE crm_bridge_import_mappings (
 org_id TEXT NOT NULL REFERENCES organizations(id), source_system TEXT NOT NULL, source_workspace TEXT NOT NULL,
 entity_kind TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL, content_hash TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
 PRIMARY KEY(org_id,source_system,source_workspace,entity_kind,source_id)
);
CREATE TABLE crm_bridge_commands (
 org_id TEXT NOT NULL, command_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
 actor_id TEXT NOT NULL, conversation_id TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
 PRIMARY KEY(org_id,command_id),
 FOREIGN KEY(org_id,actor_id) REFERENCES members(org_id,id),
 FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id)
);

CREATE TRIGGER crm_bridge_lead_insert AFTER INSERT ON leads
BEGIN
 INSERT INTO crm_bridge_state(org_id,sequence) VALUES(NEW.org_id,1)
 ON CONFLICT(org_id) DO UPDATE SET sequence=sequence+1;
 INSERT INTO crm_bridge_events(org_id,sequence,event_id,entity,record_id,record_json)
 SELECT NEW.org_id,sequence,lower(hex(randomblob(16))),'lead',NEW.id,json_object('id',NEW.id,'org_id',NEW.org_id,'name',NEW.name,'phone',NEW.phone,'email',NEW.email,'tags',NEW.tags,'interests',NEW.interests,'source',NEW.source,'market',NEW.market,'stage',NEW.stage,'assignee_id',NEW.assignee_id,'facts',NEW.facts,'summary',NEW.summary,'contact_consent_at',NEW.contact_consent_at,'contact_consent_version',NEW.contact_consent_version,'created_at',NEW.created_at,'updated_at',NEW.updated_at)
 FROM crm_bridge_state WHERE org_id=NEW.org_id;
 INSERT OR IGNORE INTO crm_bridge_entities(org_id,entity,record_id) VALUES(NEW.org_id,'lead',NEW.id);
END;

CREATE TRIGGER crm_bridge_lead_update AFTER UPDATE ON leads
BEGIN
 INSERT INTO crm_bridge_state(org_id,sequence) VALUES(NEW.org_id,1)
 ON CONFLICT(org_id) DO UPDATE SET sequence=sequence+1;
 INSERT INTO crm_bridge_events(org_id,sequence,event_id,entity,record_id,record_json)
 SELECT NEW.org_id,sequence,lower(hex(randomblob(16))),'lead',NEW.id,json_object('id',NEW.id,'org_id',NEW.org_id,'name',NEW.name,'phone',NEW.phone,'email',NEW.email,'tags',NEW.tags,'interests',NEW.interests,'source',NEW.source,'market',NEW.market,'stage',NEW.stage,'assignee_id',NEW.assignee_id,'facts',NEW.facts,'summary',NEW.summary,'contact_consent_at',NEW.contact_consent_at,'contact_consent_version',NEW.contact_consent_version,'created_at',NEW.created_at,'updated_at',NEW.updated_at)
 FROM crm_bridge_state WHERE org_id=NEW.org_id;
 INSERT OR IGNORE INTO crm_bridge_entities(org_id,entity,record_id) VALUES(NEW.org_id,'lead',NEW.id);
END;

-- Explicit bootstrap appends a current snapshot only when this entity has never
-- been logged. IGNORE/replay never allocates a sequence, even under concurrency.
CREATE TRIGGER crm_bridge_bootstrap_lead AFTER INSERT ON crm_bridge_bootstrap_items
WHEN NEW.entity='lead'
 AND EXISTS(SELECT 1 FROM leads WHERE org_id=NEW.org_id AND id=NEW.record_id)
 AND NOT EXISTS(SELECT 1 FROM crm_bridge_entities WHERE org_id=NEW.org_id AND entity='lead' AND record_id=NEW.record_id)
BEGIN
 INSERT INTO crm_bridge_state(org_id,sequence) VALUES(NEW.org_id,1)
 ON CONFLICT(org_id) DO UPDATE SET sequence=sequence+1;
 INSERT INTO crm_bridge_events(org_id,sequence,event_id,entity,record_id,record_json)
 SELECT r.org_id,s.sequence,lower(hex(randomblob(16))),'lead',r.id,json_object('id',r.id,'org_id',r.org_id,'name',r.name,'phone',r.phone,'email',r.email,'tags',r.tags,'interests',r.interests,'source',r.source,'market',r.market,'stage',r.stage,'assignee_id',r.assignee_id,'facts',r.facts,'summary',r.summary,'contact_consent_at',r.contact_consent_at,'contact_consent_version',r.contact_consent_version,'created_at',r.created_at,'updated_at',r.updated_at)
 FROM leads r JOIN crm_bridge_state s ON s.org_id=r.org_id WHERE r.org_id=NEW.org_id AND r.id=NEW.record_id;
 INSERT OR IGNORE INTO crm_bridge_entities(org_id,entity,record_id) VALUES(NEW.org_id,'lead',NEW.record_id);
END;

CREATE TRIGGER crm_bridge_conversation_insert AFTER INSERT ON conversations
BEGIN
 INSERT INTO crm_bridge_state(org_id,sequence) VALUES(NEW.org_id,1)
 ON CONFLICT(org_id) DO UPDATE SET sequence=sequence+1;
 INSERT INTO crm_bridge_events(org_id,sequence,event_id,entity,record_id,record_json)
 SELECT NEW.org_id,sequence,lower(hex(randomblob(16))),'conversation',NEW.id,json_object('id',NEW.id,'org_id',NEW.org_id,'lead_id',NEW.lead_id,'status',NEW.status,'version',NEW.version,'assignee_id',NEW.assignee_id,'generating_client_id',NEW.generating_client_id,'generation_started_at',NEW.generation_started_at,'first_customer_at',NEW.first_customer_at,'first_ai_at',NEW.first_ai_at,'handoff_at',NEW.handoff_at,'first_agent_at',NEW.first_agent_at,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'customer_message_seq',NEW.customer_message_seq)
 FROM crm_bridge_state WHERE org_id=NEW.org_id;
 INSERT OR IGNORE INTO crm_bridge_entities(org_id,entity,record_id) VALUES(NEW.org_id,'conversation',NEW.id);
END;

CREATE TRIGGER crm_bridge_conversation_update AFTER UPDATE ON conversations
BEGIN
 INSERT INTO crm_bridge_state(org_id,sequence) VALUES(NEW.org_id,1)
 ON CONFLICT(org_id) DO UPDATE SET sequence=sequence+1;
 INSERT INTO crm_bridge_events(org_id,sequence,event_id,entity,record_id,record_json)
 SELECT NEW.org_id,sequence,lower(hex(randomblob(16))),'conversation',NEW.id,json_object('id',NEW.id,'org_id',NEW.org_id,'lead_id',NEW.lead_id,'status',NEW.status,'version',NEW.version,'assignee_id',NEW.assignee_id,'generating_client_id',NEW.generating_client_id,'generation_started_at',NEW.generation_started_at,'first_customer_at',NEW.first_customer_at,'first_ai_at',NEW.first_ai_at,'handoff_at',NEW.handoff_at,'first_agent_at',NEW.first_agent_at,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'customer_message_seq',NEW.customer_message_seq)
 FROM crm_bridge_state WHERE org_id=NEW.org_id;
 INSERT OR IGNORE INTO crm_bridge_entities(org_id,entity,record_id) VALUES(NEW.org_id,'conversation',NEW.id);
END;

-- Explicit bootstrap appends a current snapshot only when this entity has never
-- been logged. IGNORE/replay never allocates a sequence, even under concurrency.
CREATE TRIGGER crm_bridge_bootstrap_conversation AFTER INSERT ON crm_bridge_bootstrap_items
WHEN NEW.entity='conversation'
 AND EXISTS(SELECT 1 FROM conversations WHERE org_id=NEW.org_id AND id=NEW.record_id)
 AND NOT EXISTS(SELECT 1 FROM crm_bridge_entities WHERE org_id=NEW.org_id AND entity='conversation' AND record_id=NEW.record_id)
BEGIN
 INSERT INTO crm_bridge_state(org_id,sequence) VALUES(NEW.org_id,1)
 ON CONFLICT(org_id) DO UPDATE SET sequence=sequence+1;
 INSERT INTO crm_bridge_events(org_id,sequence,event_id,entity,record_id,record_json)
 SELECT r.org_id,s.sequence,lower(hex(randomblob(16))),'conversation',r.id,json_object('id',r.id,'org_id',r.org_id,'lead_id',r.lead_id,'status',r.status,'version',r.version,'assignee_id',r.assignee_id,'generating_client_id',r.generating_client_id,'generation_started_at',r.generation_started_at,'first_customer_at',r.first_customer_at,'first_ai_at',r.first_ai_at,'handoff_at',r.handoff_at,'first_agent_at',r.first_agent_at,'created_at',r.created_at,'updated_at',r.updated_at,'customer_message_seq',r.customer_message_seq)
 FROM conversations r JOIN crm_bridge_state s ON s.org_id=r.org_id WHERE r.org_id=NEW.org_id AND r.id=NEW.record_id;
 INSERT OR IGNORE INTO crm_bridge_entities(org_id,entity,record_id) VALUES(NEW.org_id,'conversation',NEW.record_id);
END;

CREATE TRIGGER crm_bridge_message_insert AFTER INSERT ON messages
BEGIN
 INSERT INTO crm_bridge_state(org_id,sequence) VALUES(NEW.org_id,1)
 ON CONFLICT(org_id) DO UPDATE SET sequence=sequence+1;
 INSERT INTO crm_bridge_events(org_id,sequence,event_id,entity,record_id,record_json)
 SELECT NEW.org_id,sequence,lower(hex(randomblob(16))),'message',NEW.id,json_object('id',NEW.id,'org_id',NEW.org_id,'conversation_id',NEW.conversation_id,'role',NEW.role,'content',NEW.content,'status',NEW.status,'client_id',NEW.client_id,'reply_to_client_id',NEW.reply_to_client_id,'generation_version',NEW.generation_version,'sources',NEW.sources,'input_tokens',NEW.input_tokens,'output_tokens',NEW.output_tokens,'estimated_cost_usd',NEW.estimated_cost_usd,'created_at',NEW.created_at,'customer_seq',NEW.customer_seq,'source_owner_only',NEW.source_owner_only)
 FROM crm_bridge_state WHERE org_id=NEW.org_id;
 INSERT OR IGNORE INTO crm_bridge_entities(org_id,entity,record_id) VALUES(NEW.org_id,'message',NEW.id);
END;

CREATE TRIGGER crm_bridge_message_update AFTER UPDATE ON messages
BEGIN
 INSERT INTO crm_bridge_state(org_id,sequence) VALUES(NEW.org_id,1)
 ON CONFLICT(org_id) DO UPDATE SET sequence=sequence+1;
 INSERT INTO crm_bridge_events(org_id,sequence,event_id,entity,record_id,record_json)
 SELECT NEW.org_id,sequence,lower(hex(randomblob(16))),'message',NEW.id,json_object('id',NEW.id,'org_id',NEW.org_id,'conversation_id',NEW.conversation_id,'role',NEW.role,'content',NEW.content,'status',NEW.status,'client_id',NEW.client_id,'reply_to_client_id',NEW.reply_to_client_id,'generation_version',NEW.generation_version,'sources',NEW.sources,'input_tokens',NEW.input_tokens,'output_tokens',NEW.output_tokens,'estimated_cost_usd',NEW.estimated_cost_usd,'created_at',NEW.created_at,'customer_seq',NEW.customer_seq,'source_owner_only',NEW.source_owner_only)
 FROM crm_bridge_state WHERE org_id=NEW.org_id;
 INSERT OR IGNORE INTO crm_bridge_entities(org_id,entity,record_id) VALUES(NEW.org_id,'message',NEW.id);
END;

-- Explicit bootstrap appends a current snapshot only when this entity has never
-- been logged. IGNORE/replay never allocates a sequence, even under concurrency.
CREATE TRIGGER crm_bridge_bootstrap_message AFTER INSERT ON crm_bridge_bootstrap_items
WHEN NEW.entity='message'
 AND EXISTS(SELECT 1 FROM messages WHERE org_id=NEW.org_id AND id=NEW.record_id)
 AND NOT EXISTS(SELECT 1 FROM crm_bridge_entities WHERE org_id=NEW.org_id AND entity='message' AND record_id=NEW.record_id)
BEGIN
 INSERT INTO crm_bridge_state(org_id,sequence) VALUES(NEW.org_id,1)
 ON CONFLICT(org_id) DO UPDATE SET sequence=sequence+1;
 INSERT INTO crm_bridge_events(org_id,sequence,event_id,entity,record_id,record_json)
 SELECT r.org_id,s.sequence,lower(hex(randomblob(16))),'message',r.id,json_object('id',r.id,'org_id',r.org_id,'conversation_id',r.conversation_id,'role',r.role,'content',r.content,'status',r.status,'client_id',r.client_id,'reply_to_client_id',r.reply_to_client_id,'generation_version',r.generation_version,'sources',r.sources,'input_tokens',r.input_tokens,'output_tokens',r.output_tokens,'estimated_cost_usd',r.estimated_cost_usd,'created_at',r.created_at,'customer_seq',r.customer_seq,'source_owner_only',r.source_owner_only)
 FROM messages r JOIN crm_bridge_state s ON s.org_id=r.org_id WHERE r.org_id=NEW.org_id AND r.id=NEW.record_id;
 INSERT OR IGNORE INTO crm_bridge_entities(org_id,entity,record_id) VALUES(NEW.org_id,'message',NEW.record_id);
END;

INSERT OR IGNORE INTO schema_migrations(version) VALUES(5);

