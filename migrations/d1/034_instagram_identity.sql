-- Widen only the provider CHECK. Copy all keys unchanged; dependent foreign keys
-- stay pointed at social_identities. There are no CASCADE dependents on this table.
-- D1 supports transaction-scoped defer_foreign_keys (not foreign_keys=off).
PRAGMA defer_foreign_keys=ON;
DROP TRIGGER crm_bridge_bootstrap_socialIdentity;
CREATE TABLE social_identities_expanded (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
 provider TEXT NOT NULL CHECK(provider IN ('whatsapp','line','facebook','instagram')),
 account_id TEXT NOT NULL, remote_id TEXT NOT NULL, lead_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 opt_out INTEGER NOT NULL DEFAULT 0 CHECK(opt_out IN (0,1)), read_watermark_ms INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(org_id,id), UNIQUE(org_id,provider,account_id,remote_id), UNIQUE(org_id,conversation_id),
 FOREIGN KEY(org_id,lead_id) REFERENCES leads(org_id,id), FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id)
);
INSERT INTO social_identities_expanded SELECT * FROM social_identities;
DROP TABLE social_identities;
ALTER TABLE social_identities_expanded RENAME TO social_identities;
CREATE INDEX broadcast_social_identities_lead ON social_identities(org_id,lead_id,provider);
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
CREATE TABLE broadcast_suppressions_expanded (
 org_id TEXT NOT NULL REFERENCES organizations(id), provider TEXT NOT NULL CHECK(provider IN ('whatsapp','line','facebook','instagram')),
 remote_id TEXT NOT NULL, reason TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,provider,remote_id)
);
INSERT INTO broadcast_suppressions_expanded SELECT * FROM broadcast_suppressions;
DROP TABLE broadcast_suppressions;
ALTER TABLE broadcast_suppressions_expanded RENAME TO broadcast_suppressions;
INSERT OR IGNORE INTO schema_migrations(version) VALUES(34);
PRAGMA defer_foreign_keys=OFF;
