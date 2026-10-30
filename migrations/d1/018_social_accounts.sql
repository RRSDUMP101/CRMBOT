-- Additive only. Multi-account channel registry for the guided connection wizard
-- (SOCIAL_ACCOUNTS_ENABLED, default off). The existing env-based channel path and
-- social_channel_controls are untouched: registry state never enables sending.
-- Tokens are stored only as AES-GCM ciphertext bound to org/provider/account/purpose.
CREATE TABLE social_accounts (
 id TEXT PRIMARY KEY,
 org_id TEXT NOT NULL REFERENCES organizations(id),
 provider TEXT NOT NULL CHECK(provider IN ('whatsapp','line','facebook','instagram')),
 account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 100),
 -- WhatsApp Business Account ID, Instagram's linked Page ID or LINE channel ID.
 parent_ref TEXT NOT NULL DEFAULT '',
 display_name TEXT NOT NULL DEFAULT '',
 masked_identity TEXT NOT NULL DEFAULT '',
 -- Server-only exact business identity (e.g. sender phone digits) for provider checks.
 display_identity TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL DEFAULT 'not_connected' CHECK(state IN ('not_connected','authorizing','awaiting_selection','missing_permission','awaiting_provider_review','webhook_pending','testing','ready','degraded','expired','disconnected','paused')),
 auth_readiness TEXT NOT NULL DEFAULT 'pending' CHECK(auth_readiness IN ('pending','ready','failed','expired')),
 inbound_readiness TEXT NOT NULL DEFAULT 'pending' CHECK(inbound_readiness IN ('pending','ready','failed','unsupported')),
 outbound_readiness TEXT NOT NULL DEFAULT 'pending' CHECK(outbound_readiness IN ('pending','test_passed','ready','blocked','unsupported')),
 token_ciphertext TEXT, token_iv TEXT,
 secret_ciphertext TEXT, secret_iv TEXT,
 key_version TEXT,
 token_fingerprint TEXT,
 scopes TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(scopes)),
 expires_at TEXT,
 connected_at TEXT,
 connected_by TEXT,
 grant_id TEXT,
 last_verified_at TEXT,
 verification_expires_at TEXT,
 verification_evidence TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(verification_evidence)),
 last_error_code TEXT,
 revision INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(org_id,id), UNIQUE(org_id,provider,account_id),
 CHECK((token_ciphertext IS NULL)=(token_iv IS NULL)),
 CHECK((secret_ciphertext IS NULL)=(secret_iv IS NULL)),
 CHECK((token_ciphertext IS NULL AND secret_ciphertext IS NULL) OR key_version IS NOT NULL),
 -- A disconnected account keeps its history but never its credentials.
 CHECK(state<>'disconnected' OR (token_ciphertext IS NULL AND secret_ciphertext IS NULL)),
 -- A saved token is never "ready" by itself: every readiness gate must be proven.
 CHECK(state<>'ready' OR (token_ciphertext IS NOT NULL AND auth_readiness='ready' AND inbound_readiness='ready' AND outbound_readiness='ready'))
);
CREATE INDEX social_accounts_expiry ON social_accounts(org_id,expires_at);

-- Single-use, session-bound, 10 minute OAuth state. Only the SHA-256 of the state
-- is stored; the PKCE verifier and the short-lived user grant are encrypted.
CREATE TABLE oauth_states (
 id TEXT PRIMARY KEY,
 state_hash TEXT NOT NULL UNIQUE CHECK(length(state_hash)=64),
 org_id TEXT NOT NULL REFERENCES organizations(id),
 member_id TEXT NOT NULL,
 session_binding TEXT NOT NULL CHECK(length(session_binding)=64),
 provider TEXT NOT NULL CHECK(provider IN ('whatsapp','facebook','instagram')),
 status TEXT NOT NULL DEFAULT 'authorizing' CHECK(status IN ('authorizing','awaiting_selection','missing_permission','awaiting_provider_review','failed','completed')),
 key_version TEXT NOT NULL,
 verifier_ciphertext TEXT, verifier_iv TEXT,
 grant_ciphertext TEXT, grant_iv TEXT,
 granted_scopes TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(granted_scopes)),
 assets TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(assets)),
 error_code TEXT,
 expires_at TEXT NOT NULL,
 consumed_at TEXT,
 grant_expires_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 CHECK((verifier_ciphertext IS NULL)=(verifier_iv IS NULL)),
 CHECK((grant_ciphertext IS NULL)=(grant_iv IS NULL)),
 CHECK(consumed_at IS NOT NULL OR grant_ciphertext IS NULL),
 FOREIGN KEY(org_id,member_id) REFERENCES members(org_id,id) ON DELETE CASCADE
);
CREATE INDEX oauth_states_member ON oauth_states(org_id,member_id,created_at);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(18);
