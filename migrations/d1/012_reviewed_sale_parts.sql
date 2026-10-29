-- A reviewed customer message can contain several provider messages. Each effect has its own claim.
CREATE TABLE crm_reviewed_sale_parts (
 org_id TEXT NOT NULL,outbound_command_id TEXT NOT NULL,part_index INTEGER NOT NULL CHECK(part_index>=0),
 provider TEXT NOT NULL CHECK(provider='whatsapp'),account_id TEXT NOT NULL,remote_id TEXT NOT NULL,
 payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','preparing','sending','submitted','sent','delivered','read','failed','unknown','cancelled')),
 attempt_id TEXT,provider_media_id TEXT,provider_message_id TEXT,error_code TEXT NOT NULL DEFAULT '',
 lease_expires_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(org_id,outbound_command_id,part_index),
 FOREIGN KEY(org_id,outbound_command_id) REFERENCES social_outbound_commands(org_id,id)
);
CREATE UNIQUE INDEX crm_reviewed_sale_part_provider ON crm_reviewed_sale_parts(org_id,provider,account_id,provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX crm_reviewed_sale_part_attempt ON crm_reviewed_sale_parts(org_id,provider,account_id,attempt_id) WHERE attempt_id IS NOT NULL;
CREATE TRIGGER crm_reviewed_sale_part_manifest_immutable BEFORE UPDATE ON crm_reviewed_sale_parts
WHEN OLD.org_id!=NEW.org_id OR OLD.outbound_command_id!=NEW.outbound_command_id OR OLD.part_index!=NEW.part_index OR OLD.provider!=NEW.provider OR OLD.account_id!=NEW.account_id OR OLD.remote_id!=NEW.remote_id OR OLD.payload_json!=NEW.payload_json OR OLD.payload_hash!=NEW.payload_hash
BEGIN SELECT RAISE(ABORT,'reviewed_sale_part_manifest_immutable'); END;
CREATE TRIGGER crm_reviewed_sale_part_no_delete BEFORE DELETE ON crm_reviewed_sale_parts BEGIN SELECT RAISE(ABORT,'reviewed_sale_part_evidence_retained'); END;
INSERT OR IGNORE INTO schema_migrations(version) VALUES(12);
