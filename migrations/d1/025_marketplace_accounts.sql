-- Rebuild only the CHECK constraint; all existing rows and columns are retained.
ALTER TABLE external_accounts RENAME TO external_accounts_before_marketplaces;
CREATE TABLE external_accounts (
 id TEXT PRIMARY KEY,org_id TEXT NOT NULL,provider TEXT NOT NULL CHECK(provider IN ('gmail','outlook','shopify','hubspot','lazada','tiktokshop')),
 account_key TEXT NOT NULL,display_name TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'connected',
 scopes TEXT NOT NULL DEFAULT '[]',credential TEXT NOT NULL,expires_at TEXT,revision INTEGER NOT NULL DEFAULT 1,
 cursor TEXT NOT NULL DEFAULT '{}',enabled INTEGER NOT NULL DEFAULT 1,send_enabled INTEGER NOT NULL DEFAULT 0,
 sync_lease TEXT NOT NULL DEFAULT '',sync_lease_until TEXT NOT NULL DEFAULT '',next_sync_at TEXT NOT NULL DEFAULT '',
 refresh_lease TEXT NOT NULL DEFAULT '',refresh_lease_until TEXT NOT NULL DEFAULT '',
 last_sync_at TEXT,last_error TEXT NOT NULL DEFAULT '',test_marker TEXT NOT NULL DEFAULT '',test_passed_at TEXT,
 connected_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(org_id,provider,account_key)
);
INSERT INTO external_accounts SELECT * FROM external_accounts_before_marketplaces;
DROP TABLE external_accounts_before_marketplaces;
CREATE INDEX external_accounts_due ON external_accounts(enabled,next_sync_at,sync_lease_until);
ALTER TABLE external_accounts ADD COLUMN grant_subject TEXT NOT NULL DEFAULT '';
-- One rotating marketplace grant can only belong to one account lease.
CREATE UNIQUE INDEX external_marketplace_grant ON external_accounts(provider,grant_subject) WHERE grant_subject<>'';
INSERT OR IGNORE INTO schema_migrations(version) VALUES(25);
