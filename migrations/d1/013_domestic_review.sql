CREATE TABLE crm_domestic_review_commands (
 org_id TEXT NOT NULL,command_id TEXT NOT NULL,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL,
 source_message_id TEXT NOT NULL,actor_id TEXT NOT NULL,conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,outbound_command_id TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,command_id),UNIQUE(org_id,source_message_id),UNIQUE(org_id,outbound_command_id),
 FOREIGN KEY(org_id,actor_id) REFERENCES members(org_id,id),FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id),
 FOREIGN KEY(org_id,message_id) REFERENCES messages(org_id,id),FOREIGN KEY(org_id,outbound_command_id) REFERENCES social_outbound_commands(org_id,id)
);
CREATE TRIGGER crm_domestic_review_update BEFORE UPDATE ON crm_domestic_review_commands BEGIN SELECT RAISE(ABORT,'domestic_review_evidence_immutable'); END;
CREATE TRIGGER crm_domestic_review_delete BEFORE DELETE ON crm_domestic_review_commands BEGIN SELECT RAISE(ABORT,'domestic_review_evidence_immutable'); END;
INSERT OR IGNORE INTO schema_migrations(version) VALUES(13);
