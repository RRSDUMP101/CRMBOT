CREATE TABLE IF NOT EXISTS crm_bridge_nonces (
  org_id TEXT NOT NULL REFERENCES organizations(id),
  key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(org_id,key_id,nonce)
);
CREATE INDEX IF NOT EXISTS crm_bridge_nonces_expiry ON crm_bridge_nonces(expires_at);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(30);
