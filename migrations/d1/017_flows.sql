-- Flow Builder ("ระบบอัตโนมัติ"). Additive only; the engine is off unless FLOWS_ENABLED=true.
-- Published versions are immutable evidence; executions pin the version they started with.
CREATE TABLE flows (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','paused')),
 draft_definition TEXT NOT NULL CHECK(json_valid(draft_definition)), draft_revision INTEGER NOT NULL DEFAULT 1 CHECK(draft_revision>=1),
 current_version INTEGER, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(org_id,id)
);
CREATE INDEX flows_org_status ON flows(org_id,status);
CREATE TABLE flow_versions (
 org_id TEXT NOT NULL, flow_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1),
 definition TEXT NOT NULL CHECK(json_valid(definition)), definition_sha256 TEXT NOT NULL,
 published_by TEXT NOT NULL, published_at TEXT NOT NULL,
 PRIMARY KEY(org_id,flow_id,version),
 FOREIGN KEY(org_id,flow_id) REFERENCES flows(org_id,id),
 FOREIGN KEY(org_id,published_by) REFERENCES members(org_id,id)
);
CREATE TRIGGER flow_versions_immutable_update BEFORE UPDATE ON flow_versions BEGIN SELECT RAISE(ABORT,'flow_version_immutable'); END;
CREATE TRIGGER flow_versions_no_delete BEFORE DELETE ON flow_versions BEGIN SELECT RAISE(ABORT,'flow_version_immutable'); END;
-- One execution per flow version and trigger key. The engine also refuses a key already used by any version.
CREATE TABLE flow_executions (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, flow_id TEXT NOT NULL, version INTEGER NOT NULL,
 conversation_id TEXT NOT NULL, lead_id TEXT NOT NULL,
 trigger_kind TEXT NOT NULL, trigger_event_id TEXT NOT NULL DEFAULT '', trigger_key TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','waiting','completed','cancelled','failed')),
 step_index INTEGER NOT NULL DEFAULT 0 CHECK(step_index>=0), steps_run INTEGER NOT NULL DEFAULT 0,
 wake_at TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
 wait_customer_seq INTEGER, cancel_on_reply INTEGER NOT NULL DEFAULT 1 CHECK(cancel_on_reply IN (0,1)),
 chain_depth INTEGER NOT NULL DEFAULT 0, flow_chain TEXT NOT NULL DEFAULT '',
 lease_token TEXT NOT NULL DEFAULT '', lease_until TEXT NOT NULL DEFAULT '',
 cancel_reason TEXT NOT NULL DEFAULT '', error_code TEXT NOT NULL DEFAULT '',
 started_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
 UNIQUE(org_id,id), UNIQUE(org_id,flow_id,version,trigger_key),
 FOREIGN KEY(org_id,flow_id,version) REFERENCES flow_versions(org_id,flow_id,version),
 FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id),
 FOREIGN KEY(org_id,lead_id) REFERENCES leads(org_id,id)
);
CREATE INDEX flow_executions_due ON flow_executions(org_id,status,wake_at);
CREATE INDEX flow_executions_subject ON flow_executions(org_id,conversation_id,started_at);
CREATE INDEX flow_executions_flow_key ON flow_executions(org_id,flow_id,trigger_key);
CREATE TABLE flow_execution_steps (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, execution_id TEXT NOT NULL,
 step_index INTEGER NOT NULL, step_id TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL,
 detail TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(detail)), created_at TEXT NOT NULL,
 FOREIGN KEY(org_id,execution_id) REFERENCES flow_executions(org_id,id)
);
CREATE INDEX flow_steps_execution ON flow_execution_steps(org_id,execution_id,created_at);
-- Durable outbox of lead label/stage changes (staff edits and flow actions). flow_chain lists every
-- flow that led to the change, so no flow is retriggered by its own (direct or indirect) actions;
-- depth bounds cross-flow chains.
CREATE TABLE flow_events (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('label_added','stage_changed')),
 lead_id TEXT NOT NULL, value TEXT NOT NULL, previous_value TEXT NOT NULL DEFAULT '',
 origin_flow_id TEXT, origin_execution_id TEXT, flow_chain TEXT NOT NULL DEFAULT '', depth INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processed')),
 created_at TEXT NOT NULL, processed_at TEXT,
 FOREIGN KEY(org_id,lead_id) REFERENCES leads(org_id,id)
);
CREATE INDEX flow_events_pending ON flow_events(org_id,status,created_at);
-- At most one automated greeting per conversation, across all flows and versions.
CREATE TABLE flow_greetings (
 org_id TEXT NOT NULL, conversation_id TEXT NOT NULL, execution_id TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,conversation_id),
 FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id)
);
-- Links an outbound intent to the published flow version whose Admin approved its exact text.
CREATE TABLE flow_outbound_commands (
 org_id TEXT NOT NULL, outbound_command_id TEXT NOT NULL, execution_id TEXT NOT NULL,
 flow_id TEXT NOT NULL, version INTEGER NOT NULL, step_id TEXT NOT NULL, approved_by TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,outbound_command_id),
 FOREIGN KEY(org_id,outbound_command_id) REFERENCES social_outbound_commands(org_id,id),
 FOREIGN KEY(org_id,execution_id) REFERENCES flow_executions(org_id,id)
);
CREATE INDEX flow_outbound_flow ON flow_outbound_commands(org_id,flow_id);
CREATE INDEX flow_outbound_day ON flow_outbound_commands(org_id,created_at);
CREATE TRIGGER flow_outbound_immutable_update BEFORE UPDATE ON flow_outbound_commands BEGIN SELECT RAISE(ABORT,'flow_outbound_evidence_immutable'); END;
CREATE TRIGGER flow_outbound_no_delete BEFORE DELETE ON flow_outbound_commands BEGIN SELECT RAISE(ABORT,'flow_outbound_evidence_immutable'); END;
-- Organization-wide emergency pause. A missing row means not paused.
CREATE TABLE flow_controls (
 org_id TEXT PRIMARY KEY NOT NULL REFERENCES organizations(id),
 paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)), updated_by TEXT, updated_at TEXT NOT NULL
);
-- Keyset progress of one scheduled slot, so a slot is processed once in bounded batches.
CREATE TABLE flow_schedule_runs (
 org_id TEXT NOT NULL, flow_id TEXT NOT NULL, slot TEXT NOT NULL, version INTEGER NOT NULL,
 cursor TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)), updated_at TEXT NOT NULL,
 PRIMARY KEY(org_id,flow_id,slot)
);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(17);
