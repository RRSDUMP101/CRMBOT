-- Additive only. Provider identity never follows a display name or phone heuristic.
CREATE TABLE social_identities (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
 provider TEXT NOT NULL CHECK(provider IN ('whatsapp','line','facebook')),
 account_id TEXT NOT NULL, remote_id TEXT NOT NULL, lead_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 opt_out INTEGER NOT NULL DEFAULT 0 CHECK(opt_out IN (0,1)),
 read_watermark_ms INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(org_id,id), UNIQUE(org_id,provider,account_id,remote_id), UNIQUE(org_id,conversation_id),
 FOREIGN KEY(org_id,lead_id) REFERENCES leads(org_id,id),
 FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id)
);
CREATE TABLE social_channel_controls (
 org_id TEXT NOT NULL REFERENCES organizations(id), provider TEXT NOT NULL, account_id TEXT NOT NULL,
 send_enabled INTEGER NOT NULL DEFAULT 0 CHECK(send_enabled IN (0,1)),
 emergency_stop INTEGER NOT NULL DEFAULT 1 CHECK(emergency_stop IN (0,1)),
 verified_at TEXT, epoch INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
 PRIMARY KEY(org_id,provider,account_id)
);
CREATE TABLE social_events (
 org_id TEXT NOT NULL REFERENCES organizations(id), provider TEXT NOT NULL, account_id TEXT NOT NULL,
 event_id TEXT NOT NULL, event_kind TEXT NOT NULL, provider_message_id TEXT,
 remote_id TEXT NOT NULL DEFAULT '', payload_sha256 TEXT NOT NULL, received_at TEXT NOT NULL,
 PRIMARY KEY(org_id,provider,account_id,event_id)
);
CREATE TABLE social_message_provenance (
 org_id TEXT NOT NULL, message_id TEXT NOT NULL, provider TEXT NOT NULL, account_id TEXT NOT NULL,
 remote_id TEXT NOT NULL, provider_message_id TEXT, provider_type TEXT NOT NULL,
 direction TEXT NOT NULL CHECK(direction IN ('in','out')),
 delivery_status TEXT NOT NULL CHECK(delivery_status IN ('received','queued','sending','submitted','sent','delivered','read','failed','unknown','cancelled')),
 provider_timestamp TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', removed_at TEXT,
 PRIMARY KEY(org_id,message_id), UNIQUE(org_id,provider,account_id,provider_message_id),
 FOREIGN KEY(org_id,message_id) REFERENCES messages(org_id,id) ON DELETE CASCADE
);
CREATE TABLE social_message_attachments (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, message_id TEXT NOT NULL,
 provider TEXT NOT NULL, account_id TEXT NOT NULL, media_type TEXT NOT NULL,
 provider_ref TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
 storage_state TEXT NOT NULL DEFAULT 'provider_reference' CHECK(storage_state IN ('provider_reference','archived','removed')),
 object_key TEXT, removed_at TEXT,
 FOREIGN KEY(org_id,message_id) REFERENCES social_message_provenance(org_id,message_id) ON DELETE CASCADE
);
CREATE TABLE social_tombstones (
 org_id TEXT NOT NULL REFERENCES organizations(id), provider TEXT NOT NULL, account_id TEXT NOT NULL,
 remote_id TEXT NOT NULL, provider_message_id TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,provider,account_id,remote_id,provider_message_id)
);
CREATE TABLE social_delivery_receipts (
 org_id TEXT NOT NULL REFERENCES organizations(id), provider TEXT NOT NULL, account_id TEXT NOT NULL,
 provider_message_id TEXT NOT NULL, remote_id TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL CHECK(status IN ('sent','delivered','read','failed')),
 rank INTEGER NOT NULL, provider_timestamp TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(org_id,provider,account_id,provider_message_id)
);
CREATE TABLE social_outbound_commands (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, identity_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 message_id TEXT NOT NULL, provider TEXT NOT NULL, account_id TEXT NOT NULL, remote_id TEXT NOT NULL,
 body TEXT NOT NULL, conversation_version INTEGER NOT NULL, approved_by TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','submitted','sent','delivered','read','failed','unknown','cancelled')),
 attempt_id TEXT, provider_message_id TEXT, control_epoch INTEGER, lease_expires_at TEXT,
 error_code TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(org_id,id), UNIQUE(org_id,message_id),
 FOREIGN KEY(org_id,identity_id) REFERENCES social_identities(org_id,id),
 FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id),
 FOREIGN KEY(org_id,message_id) REFERENCES messages(org_id,id)
);
CREATE INDEX social_commands_pending ON social_outbound_commands(org_id,status,created_at);
CREATE INDEX social_provenance_provider ON social_message_provenance(org_id,provider,account_id,remote_id);
CREATE INDEX social_attachments_message ON social_message_attachments(org_id,message_id);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(6);

-- Social snapshots share the same atomic outbox sequence as native CRM rows.
CREATE TRIGGER crm_bridge_socialIdentity_insert AFTER INSERT ON social_identities
BEGIN
 INSERT INTO crm_bridge_state(org_id,sequence) VALUES(NEW.org_id,1) ON CONFLICT(org_id) DO UPDATE SET sequence=sequence+1;
 INSERT INTO crm_bridge_events(org_id,sequence,event_id,entity,record_id,record_json)
 SELECT NEW.org_id,sequence,lower(hex(randomblob(16))),'socialIdentity',NEW.id,json_object('id',NEW.id,'org_id',NEW.org_id,'provider',NEW.provider,'account_id',NEW.account_id,'remote_id',NEW.remote_id,'lead_id',NEW.lead_id,'conversation_id',NEW.conversation_id,'opt_out',NEW.opt_out,'read_watermark_ms',NEW.read_watermark_ms,'created_at',NEW.created_at,'updated_at',NEW.updated_at) FROM crm_bridge_state WHERE org_id=NEW.org_id;
 INSERT OR IGNORE INTO crm_bridge_entities(org_id,entity,record_id) VALUES(NEW.org_id,'socialIdentity',NEW.id);
END;

CREATE TRIGGER crm_bridge_socialIdentity_update AFTER UPDATE ON social_identities
BEGIN
 INSERT INTO crm_bridge_state(org_id,sequence) VALUES(NEW.org_id,1) ON CONFLICT(org_id) DO UPDATE SET sequence=sequence+1;
 INSERT INTO crm_bridge_events(org_id,sequence,event_id,entity,record_id,record_json)
 SELECT NEW.org_id,sequence,lower(hex(randomblob(16))),'socialIdentity',NEW.id,json_object('id',NEW.id,'org_id',NEW.org_id,'provider',NEW.provider,'account_id',NEW.account_id,'remote_id',NEW.remote_id,'lead_id',NEW.lead_id,'conversation_id',NEW.conversation_id,'opt_out',NEW.opt_out,'read_watermark_ms',NEW.read_watermark_ms,'created_at',NEW.created_at,'updated_at',NEW.updated_at) FROM crm_bridge_state WHERE org_id=NEW.org_id;
 INSERT OR IGNORE INTO crm_bridge_entities(org_id,entity,record_id) VALUES(NEW.org_id,'socialIdentity',NEW.id);
END;

CREATE TRIGGER crm_bridge_bootstrap_socialIdentity AFTER INSERT ON crm_bridge_bootstrap_items
WHEN NEW.entity='socialIdentity'
 AND EXISTS(SELECT 1 FROM social_identities WHERE org_id=NEW.org_id AND id=NEW.record_id)
 AND NOT EXISTS(SELECT 1 FROM crm_bridge_entities WHERE org_id=NEW.org_id AND entity='socialIdentity' AND record_id=NEW.record_id)
BEGIN
 INSERT INTO crm_bridge_state(org_id,sequence) VALUES(NEW.org_id,1) ON CONFLICT(org_id) DO UPDATE SET sequence=sequence+1;
 INSERT INTO crm_bridge_events(org_id,sequence,event_id,entity,record_id,record_json)
 SELECT r.org_id,s.sequence,lower(hex(randomblob(16))),'socialIdentity',r.id,json_object('id',r.id,'org_id',r.org_id,'provider',r.provider,'account_id',r.account_id,'remote_id',r.remote_id,'lead_id',r.lead_id,'conversation_id',r.conversation_id,'opt_out',r.opt_out,'read_watermark_ms',r.read_watermark_ms,'created_at',r.created_at,'updated_at',r.updated_at)
 FROM social_identities r JOIN crm_bridge_state s ON s.org_id=r.org_id WHERE r.org_id=NEW.org_id AND r.id=NEW.record_id;
 INSERT OR IGNORE INTO crm_bridge_entities(org_id,entity,record_id) VALUES(NEW.org_id,'socialIdentity',NEW.record_id);
END;

CREATE TRIGGER crm_bridge_messageProvenance_insert AFTER INSERT ON social_message_provenance
BEGIN
 INSERT INTO crm_bridge_state(org_id,sequence) VALUES(NEW.org_id,1) ON CONFLICT(org_id) DO UPDATE SET sequence=sequence+1;
 INSERT INTO crm_bridge_events(org_id,sequence,event_id,entity,record_id,record_json)
 SELECT NEW.org_id,sequence,lower(hex(randomblob(16))),'messageProvenance',NEW.message_id,json_object('id',NEW.message_id,'org_id',NEW.org_id,'message_id',NEW.message_id,'provider',NEW.provider,'account_id',NEW.account_id,'remote_id',NEW.remote_id,'provider_message_id',NEW.provider_message_id,'provider_type',NEW.provider_type,'direction',NEW.direction,'delivery_status',NEW.delivery_status,'provider_timestamp',NEW.provider_timestamp,'metadata',NEW.metadata,'removed_at',NEW.removed_at) FROM crm_bridge_state WHERE org_id=NEW.org_id;
 INSERT OR IGNORE INTO crm_bridge_entities(org_id,entity,record_id) VALUES(NEW.org_id,'messageProvenance',NEW.message_id);
END;

CREATE TRIGGER crm_bridge_messageProvenance_update AFTER UPDATE ON social_message_provenance
BEGIN
 INSERT INTO crm_bridge_state(org_id,sequence) VALUES(NEW.org_id,1) ON CONFLICT(org_id) DO UPDATE SET sequence=sequence+1;
 INSERT INTO crm_bridge_events(org_id,sequence,event_id,entity,record_id,record_json)
 SELECT NEW.org_id,sequence,lower(hex(randomblob(16))),'messageProvenance',NEW.message_id,json_object('id',NEW.message_id,'org_id',NEW.org_id,'message_id',NEW.message_id,'provider',NEW.provider,'account_id',NEW.account_id,'remote_id',NEW.remote_id,'provider_message_id',NEW.provider_message_id,'provider_type',NEW.provider_type,'direction',NEW.direction,'delivery_status',NEW.delivery_status,'provider_timestamp',NEW.provider_timestamp,'metadata',NEW.metadata,'removed_at',NEW.removed_at) FROM crm_bridge_state WHERE org_id=NEW.org_id;
 INSERT OR IGNORE INTO crm_bridge_entities(org_id,entity,record_id) VALUES(NEW.org_id,'messageProvenance',NEW.message_id);
END;

CREATE TRIGGER crm_bridge_bootstrap_messageProvenance AFTER INSERT ON crm_bridge_bootstrap_items
WHEN NEW.entity='messageProvenance'
 AND EXISTS(SELECT 1 FROM social_message_provenance WHERE org_id=NEW.org_id AND message_id=NEW.record_id)
 AND NOT EXISTS(SELECT 1 FROM crm_bridge_entities WHERE org_id=NEW.org_id AND entity='messageProvenance' AND record_id=NEW.record_id)
BEGIN
 INSERT INTO crm_bridge_state(org_id,sequence) VALUES(NEW.org_id,1) ON CONFLICT(org_id) DO UPDATE SET sequence=sequence+1;
 INSERT INTO crm_bridge_events(org_id,sequence,event_id,entity,record_id,record_json)
 SELECT r.org_id,s.sequence,lower(hex(randomblob(16))),'messageProvenance',r.message_id,json_object('id',r.message_id,'org_id',r.org_id,'message_id',r.message_id,'provider',r.provider,'account_id',r.account_id,'remote_id',r.remote_id,'provider_message_id',r.provider_message_id,'provider_type',r.provider_type,'direction',r.direction,'delivery_status',r.delivery_status,'provider_timestamp',r.provider_timestamp,'metadata',r.metadata,'removed_at',r.removed_at)
 FROM social_message_provenance r JOIN crm_bridge_state s ON s.org_id=r.org_id WHERE r.org_id=NEW.org_id AND r.message_id=NEW.record_id;
 INSERT OR IGNORE INTO crm_bridge_entities(org_id,entity,record_id) VALUES(NEW.org_id,'messageProvenance',NEW.record_id);
END;

CREATE TRIGGER crm_bridge_attachment_insert AFTER INSERT ON social_message_attachments
BEGIN
 INSERT INTO crm_bridge_state(org_id,sequence) VALUES(NEW.org_id,1) ON CONFLICT(org_id) DO UPDATE SET sequence=sequence+1;
 INSERT INTO crm_bridge_events(org_id,sequence,event_id,entity,record_id,record_json)
 SELECT NEW.org_id,sequence,lower(hex(randomblob(16))),'attachment',NEW.id,json_object('id',NEW.id,'org_id',NEW.org_id,'message_id',NEW.message_id,'provider',NEW.provider,'account_id',NEW.account_id,'media_type',NEW.media_type,'provider_ref',NEW.provider_ref,'metadata',NEW.metadata,'storage_state',NEW.storage_state,'object_key',NEW.object_key,'removed_at',NEW.removed_at) FROM crm_bridge_state WHERE org_id=NEW.org_id;
 INSERT OR IGNORE INTO crm_bridge_entities(org_id,entity,record_id) VALUES(NEW.org_id,'attachment',NEW.id);
END;

CREATE TRIGGER crm_bridge_attachment_update AFTER UPDATE ON social_message_attachments
BEGIN
 INSERT INTO crm_bridge_state(org_id,sequence) VALUES(NEW.org_id,1) ON CONFLICT(org_id) DO UPDATE SET sequence=sequence+1;
 INSERT INTO crm_bridge_events(org_id,sequence,event_id,entity,record_id,record_json)
 SELECT NEW.org_id,sequence,lower(hex(randomblob(16))),'attachment',NEW.id,json_object('id',NEW.id,'org_id',NEW.org_id,'message_id',NEW.message_id,'provider',NEW.provider,'account_id',NEW.account_id,'media_type',NEW.media_type,'provider_ref',NEW.provider_ref,'metadata',NEW.metadata,'storage_state',NEW.storage_state,'object_key',NEW.object_key,'removed_at',NEW.removed_at) FROM crm_bridge_state WHERE org_id=NEW.org_id;
 INSERT OR IGNORE INTO crm_bridge_entities(org_id,entity,record_id) VALUES(NEW.org_id,'attachment',NEW.id);
END;

CREATE TRIGGER crm_bridge_bootstrap_attachment AFTER INSERT ON crm_bridge_bootstrap_items
WHEN NEW.entity='attachment'
 AND EXISTS(SELECT 1 FROM social_message_attachments WHERE org_id=NEW.org_id AND id=NEW.record_id)
 AND NOT EXISTS(SELECT 1 FROM crm_bridge_entities WHERE org_id=NEW.org_id AND entity='attachment' AND record_id=NEW.record_id)
BEGIN
 INSERT INTO crm_bridge_state(org_id,sequence) VALUES(NEW.org_id,1) ON CONFLICT(org_id) DO UPDATE SET sequence=sequence+1;
 INSERT INTO crm_bridge_events(org_id,sequence,event_id,entity,record_id,record_json)
 SELECT r.org_id,s.sequence,lower(hex(randomblob(16))),'attachment',r.id,json_object('id',r.id,'org_id',r.org_id,'message_id',r.message_id,'provider',r.provider,'account_id',r.account_id,'media_type',r.media_type,'provider_ref',r.provider_ref,'metadata',r.metadata,'storage_state',r.storage_state,'object_key',r.object_key,'removed_at',r.removed_at)
 FROM social_message_attachments r JOIN crm_bridge_state s ON s.org_id=r.org_id WHERE r.org_id=NEW.org_id AND r.id=NEW.record_id;
 INSERT OR IGNORE INTO crm_bridge_entities(org_id,entity,record_id) VALUES(NEW.org_id,'attachment',NEW.record_id);
END;


