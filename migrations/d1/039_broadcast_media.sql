-- Private immutable assets. Each outbound command receives its own approval manifest
-- and short-lived provider-fetch capability. Existing rows retain text-only behavior.
ALTER TABLE broadcast_campaigns ADD COLUMN media_asset_id TEXT;
CREATE TABLE broadcast_assets (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, campaign_id TEXT NOT NULL,
 provider TEXT NOT NULL CHECK(provider IN ('whatsapp','line')), account_id TEXT NOT NULL,
 uploaded_by TEXT NOT NULL, filename TEXT NOT NULL, content_type TEXT NOT NULL,
 size_bytes INTEGER NOT NULL CHECK(size_bytes>0), sha256 TEXT NOT NULL, object_key TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','deleting')),
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,campaign_id) REFERENCES broadcast_campaigns(org_id,id),
 FOREIGN KEY(org_id,uploaded_by) REFERENCES members(org_id,id)
);
CREATE INDEX broadcast_assets_campaign ON broadcast_assets(org_id,campaign_id,status);
CREATE TABLE broadcast_command_assets (
 org_id TEXT NOT NULL, command_id TEXT NOT NULL, asset_id TEXT NOT NULL,
 campaign_id TEXT NOT NULL, campaign_version INTEGER NOT NULL, message_id TEXT NOT NULL,
 provider TEXT NOT NULL, account_id TEXT NOT NULL, approved_by TEXT NOT NULL,
 body TEXT NOT NULL, sha256 TEXT NOT NULL, object_key TEXT NOT NULL,
 filename TEXT NOT NULL, content_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
 attachment_id TEXT NOT NULL, provider_media_id TEXT,
 grant_hash TEXT, grant_expires_at TEXT, grant_attempt TEXT, grant_fingerprint TEXT,
 grant_epoch INTEGER, grant_reads INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,command_id), UNIQUE(org_id,message_id), UNIQUE(grant_hash),
 FOREIGN KEY(org_id,command_id) REFERENCES social_outbound_commands(org_id,id),
 FOREIGN KEY(org_id,asset_id) REFERENCES broadcast_assets(org_id,id),
 FOREIGN KEY(org_id,campaign_id) REFERENCES broadcast_campaigns(org_id,id)
);
CREATE TRIGGER broadcast_asset_source_immutable BEFORE UPDATE ON broadcast_assets
WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.campaign_id IS NOT OLD.campaign_id
 OR NEW.provider IS NOT OLD.provider OR NEW.account_id IS NOT OLD.account_id OR NEW.uploaded_by IS NOT OLD.uploaded_by
 OR NEW.filename IS NOT OLD.filename OR NEW.content_type IS NOT OLD.content_type OR NEW.size_bytes IS NOT OLD.size_bytes
 OR NEW.sha256 IS NOT OLD.sha256 OR NEW.object_key IS NOT OLD.object_key
BEGIN SELECT RAISE(ABORT,'broadcast_asset_source_immutable'); END;
CREATE TRIGGER broadcast_asset_approval_immutable BEFORE UPDATE ON broadcast_command_assets
WHEN NEW.org_id IS NOT OLD.org_id OR NEW.command_id IS NOT OLD.command_id OR NEW.asset_id IS NOT OLD.asset_id
 OR NEW.campaign_id IS NOT OLD.campaign_id OR NEW.campaign_version IS NOT OLD.campaign_version
 OR NEW.message_id IS NOT OLD.message_id OR NEW.provider IS NOT OLD.provider OR NEW.account_id IS NOT OLD.account_id
 OR NEW.approved_by IS NOT OLD.approved_by OR NEW.body IS NOT OLD.body OR NEW.sha256 IS NOT OLD.sha256
 OR NEW.object_key IS NOT OLD.object_key OR NEW.filename IS NOT OLD.filename OR NEW.content_type IS NOT OLD.content_type
 OR NEW.size_bytes IS NOT OLD.size_bytes OR NEW.attachment_id IS NOT OLD.attachment_id
BEGIN SELECT RAISE(ABORT,'broadcast_asset_approval_immutable'); END;
INSERT OR IGNORE INTO schema_migrations(version) VALUES(39);
