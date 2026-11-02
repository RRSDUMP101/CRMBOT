CREATE TABLE external_accounts (
 id TEXT PRIMARY KEY,org_id TEXT NOT NULL,provider TEXT NOT NULL CHECK(provider IN ('gmail','outlook','shopify','hubspot')),
 account_key TEXT NOT NULL,display_name TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'connected',
 scopes TEXT NOT NULL DEFAULT '[]',credential TEXT NOT NULL,expires_at TEXT,revision INTEGER NOT NULL DEFAULT 1,
 cursor TEXT NOT NULL DEFAULT '{}',enabled INTEGER NOT NULL DEFAULT 1,send_enabled INTEGER NOT NULL DEFAULT 0,
 sync_lease TEXT NOT NULL DEFAULT '',sync_lease_until TEXT NOT NULL DEFAULT '',next_sync_at TEXT NOT NULL DEFAULT '',
 refresh_lease TEXT NOT NULL DEFAULT '',refresh_lease_until TEXT NOT NULL DEFAULT '',
 last_sync_at TEXT,last_error TEXT NOT NULL DEFAULT '',test_marker TEXT NOT NULL DEFAULT '',test_passed_at TEXT,
 connected_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(org_id,provider,account_key)
);
CREATE INDEX external_accounts_due ON external_accounts(enabled,next_sync_at,sync_lease_until);
CREATE TABLE external_oauth_states (
 state_hash TEXT PRIMARY KEY,org_id TEXT NOT NULL,member_id TEXT NOT NULL,provider TEXT NOT NULL,
 shop TEXT NOT NULL DEFAULT '',verifier TEXT NOT NULL,requested_scopes TEXT NOT NULL,
 expires_at TEXT NOT NULL,used_at TEXT,created_at TEXT NOT NULL
);
CREATE TABLE external_threads (
 org_id TEXT NOT NULL,account_id TEXT NOT NULL,thread_id TEXT NOT NULL,conversation_id TEXT NOT NULL,
 lead_id TEXT NOT NULL,subject TEXT NOT NULL DEFAULT '',reply_to TEXT NOT NULL,last_remote_id TEXT NOT NULL DEFAULT '',
 last_message_id TEXT NOT NULL DEFAULT '',last_received_at TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(org_id,account_id,thread_id),UNIQUE(org_id,conversation_id)
);
CREATE TABLE external_messages (
 org_id TEXT NOT NULL,account_id TEXT NOT NULL,remote_id TEXT NOT NULL,message_id TEXT NOT NULL,thread_id TEXT NOT NULL,
 internet_id TEXT NOT NULL DEFAULT '',removed_at TEXT,PRIMARY KEY(org_id,account_id,remote_id)
);
CREATE TABLE external_send_commands (
 id TEXT PRIMARY KEY,org_id TEXT NOT NULL,account_id TEXT NOT NULL,conversation_id TEXT,message_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('reply','self_test')),payload TEXT NOT NULL,payload_hash TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','submitted','unknown','failed','cancelled')),
 approved_by TEXT NOT NULL,account_revision INTEGER NOT NULL,conversation_version INTEGER,
 created_at TEXT NOT NULL,attempted_at TEXT,submitted_at TEXT,provider_id TEXT NOT NULL DEFAULT '',error_code TEXT NOT NULL DEFAULT '',
 UNIQUE(org_id,message_id)
);
CREATE TABLE external_resources (
 org_id TEXT NOT NULL,account_id TEXT NOT NULL,kind TEXT NOT NULL,remote_id TEXT NOT NULL,
 payload TEXT NOT NULL,remote_updated_at TEXT NOT NULL,deleted_at TEXT,
 PRIMARY KEY(org_id,account_id,kind,remote_id)
);
CREATE TABLE external_webhook_receipts (
 account_id TEXT NOT NULL,event_id TEXT NOT NULL,body_hash TEXT NOT NULL,topic TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(account_id,event_id)
);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(24);
