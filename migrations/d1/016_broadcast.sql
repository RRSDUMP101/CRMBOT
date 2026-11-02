-- Additive only. Broadcasts never create identities, leads or consent: recipients are
-- materialized at launch only from existing social identities that pass eligibility.
-- Sending reuses social_outbound_commands, its guards, live gates and emergency stop.
CREATE TABLE broadcast_campaigns (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
 name TEXT NOT NULL,
 provider TEXT NOT NULL CHECK(provider IN ('whatsapp','line')),
 account_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','sending','paused','completed','cancelled')),
 message_kind TEXT NOT NULL DEFAULT 'text' CHECK(message_kind IN ('text','template')),
 message_text TEXT NOT NULL DEFAULT '',
 template_name TEXT, template_language TEXT,
 template_params TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(template_params)),
 -- Approved WhatsApp template body rendered from the provider at launch/resume.
 template_body TEXT, template_verified_at TEXT,
 segment TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(segment)),
 scheduled_at TEXT,
 created_by TEXT NOT NULL, approved_by TEXT, launched_at TEXT, launched_count INTEGER,
 launch_summary TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(launch_summary)),
 completed_at TEXT, cancelled_at TEXT,
 runner_lease_id TEXT, runner_lease_until TEXT,
 version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES members(org_id,id),
 FOREIGN KEY(org_id,approved_by) REFERENCES members(org_id,id)
);
CREATE INDEX broadcast_campaigns_org ON broadcast_campaigns(org_id,updated_at);

CREATE TABLE broadcast_recipients (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, campaign_id TEXT NOT NULL,
 identity_id TEXT NOT NULL, remote_id TEXT NOT NULL, lead_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','skipped','queued','submitted','failed','unknown')),
 skip_reason TEXT NOT NULL DEFAULT '',
 -- campaign:identity. One recipient row, and at most one live outbound command, per identity.
 idempotency_key TEXT NOT NULL,
 outbound_command_id TEXT, message_id TEXT, queued_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(campaign_id,identity_id), UNIQUE(org_id,idempotency_key), UNIQUE(org_id,outbound_command_id),
 FOREIGN KEY(org_id,campaign_id) REFERENCES broadcast_campaigns(org_id,id),
 FOREIGN KEY(org_id,identity_id) REFERENCES social_identities(org_id,id)
);
CREATE INDEX broadcast_recipients_campaign ON broadcast_recipients(org_id,campaign_id,status,created_at);
CREATE INDEX broadcast_recipients_queued ON broadcast_recipients(org_id,queued_at);

-- Test sends go only to the configured channel test recipient through the normal outbound path.
CREATE TABLE broadcast_test_sends (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_version INTEGER NOT NULL,
 request_id TEXT NOT NULL, identity_id TEXT NOT NULL, remote_id TEXT NOT NULL,
 outbound_command_id TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(org_id,request_id), UNIQUE(org_id,outbound_command_id),
 FOREIGN KEY(org_id,campaign_id) REFERENCES broadcast_campaigns(org_id,id),
 FOREIGN KEY(org_id,identity_id) REFERENCES social_identities(org_id,id)
);
CREATE INDEX broadcast_test_sends_campaign ON broadcast_test_sends(org_id,campaign_id,campaign_version);

-- Durable do-not-broadcast list. Rows are never removed by application code.
CREATE TABLE broadcast_suppressions (
 org_id TEXT NOT NULL REFERENCES organizations(id),
 provider TEXT NOT NULL CHECK(provider IN ('whatsapp','line','facebook')),
 remote_id TEXT NOT NULL, reason TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,provider,remote_id)
);

-- CSV dry-run previews. Raw imported values are not stored: only a hash, a masked
-- suffix and a match against an existing identity. Rows never imply consent.
CREATE TABLE broadcast_import_rows (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, import_id TEXT NOT NULL, campaign_id TEXT NOT NULL,
 provider TEXT NOT NULL, row_number INTEGER NOT NULL,
 remote_hash TEXT NOT NULL DEFAULT '', remote_masked TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL CHECK(status IN ('valid','invalid','duplicate')),
 error_code TEXT NOT NULL DEFAULT '', matched_identity_id TEXT, eligibility TEXT NOT NULL DEFAULT '',
 created_by TEXT NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(org_id,campaign_id) REFERENCES broadcast_campaigns(org_id,id)
);
CREATE INDEX broadcast_import_rows_import ON broadcast_import_rows(org_id,campaign_id,import_id,row_number);

-- Eligibility lookups (follow evidence and lead-wide opt-out) without full scans.
CREATE INDEX IF NOT EXISTS broadcast_social_events_remote ON social_events(org_id,provider,account_id,remote_id,event_kind);
CREATE INDEX IF NOT EXISTS broadcast_social_identities_lead ON social_identities(org_id,lead_id,provider);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(16);
