-- Exact, source-validated AI approvals are separate from ordinary human replies.
CREATE TABLE crm_approved_ai_commands (
 org_id TEXT NOT NULL,command_id TEXT NOT NULL,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL,
 source_workspace TEXT NOT NULL CHECK(source_workspace IN ('live','domestic')),
 source_outbox_id TEXT NOT NULL,source_job_id TEXT NOT NULL,result_hash TEXT NOT NULL,
 actor_id TEXT NOT NULL,conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,outbound_command_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,command_id),UNIQUE(org_id,source_workspace,source_outbox_id),UNIQUE(org_id,source_workspace,source_job_id,result_hash),
 UNIQUE(org_id,outbound_command_id),
 FOREIGN KEY(org_id,actor_id) REFERENCES members(org_id,id),
 FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id),
 FOREIGN KEY(org_id,message_id) REFERENCES messages(org_id,id),
 FOREIGN KEY(org_id,outbound_command_id) REFERENCES social_outbound_commands(org_id,id)
);
CREATE TRIGGER crm_approved_ai_immutable_update BEFORE UPDATE ON crm_approved_ai_commands BEGIN SELECT RAISE(ABORT,'approved_ai_evidence_immutable'); END;
CREATE TRIGGER crm_approved_ai_immutable_delete BEFORE DELETE ON crm_approved_ai_commands BEGIN SELECT RAISE(ABORT,'approved_ai_evidence_immutable'); END;
INSERT OR IGNORE INTO schema_migrations(version) VALUES(10);
