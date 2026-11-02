-- Scoped integrations are operator-configured and default off. No backfill or sends.
CREATE TABLE crm_public_api_keys (
 id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),created_by TEXT NOT NULL,
 name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,token_hint TEXT NOT NULL,scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),
 expires_at INTEGER NOT NULL,revoked_at INTEGER,last_used_at INTEGER,created_at INTEGER NOT NULL,
 FOREIGN KEY(org_id,created_by) REFERENCES members(org_id,id)
);
CREATE INDEX crm_public_api_keys_org ON crm_public_api_keys(org_id,created_at);
CREATE TABLE crm_public_webhooks (
 id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),created_by TEXT NOT NULL,
 name TEXT NOT NULL,url TEXT NOT NULL,events_json TEXT NOT NULL CHECK(json_valid(events_json)),
 state TEXT NOT NULL DEFAULT 'paused' CHECK(state IN ('active','paused')),version INTEGER NOT NULL DEFAULT 1,
 cursor INTEGER NOT NULL DEFAULT 0,secret_json TEXT NOT NULL CHECK(json_valid(secret_json)),signing_version INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 FOREIGN KEY(org_id,created_by) REFERENCES members(org_id,id)
);
CREATE INDEX crm_public_webhooks_due ON crm_public_webhooks(state,updated_at);
CREATE TABLE crm_public_webhook_deliveries (
 id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),subscription_id TEXT NOT NULL REFERENCES crm_public_webhooks(id),
 sequence INTEGER NOT NULL,event_id TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),body_hash TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','delivered','dead')),
 attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL DEFAULT 5,next_attempt_at INTEGER NOT NULL DEFAULT 0,
 lease TEXT NOT NULL DEFAULT '',lease_until INTEGER NOT NULL DEFAULT 0,http_status INTEGER,last_error TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(subscription_id,sequence)
);
CREATE INDEX crm_public_webhook_deliveries_due ON crm_public_webhook_deliveries(status,next_attempt_at);
CREATE TABLE crm_public_webhook_attempts (
 id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),delivery_id TEXT NOT NULL REFERENCES crm_public_webhook_deliveries(id),
 attempt INTEGER NOT NULL,http_status INTEGER,error_code TEXT NOT NULL,duration_ms INTEGER NOT NULL,created_at INTEGER NOT NULL
);
CREATE INDEX crm_public_webhook_attempts_delivery ON crm_public_webhook_attempts(org_id,delivery_id,created_at);
INSERT INTO schema_migrations(version) VALUES(32);

