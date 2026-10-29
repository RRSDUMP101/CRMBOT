-- Verification never enables a sender. Only the authenticated admin workflow may
-- advance disabled -> restricted test -> live after matching current evidence.
ALTER TABLE social_channel_controls ADD COLUMN verification_id TEXT;
ALTER TABLE social_channel_controls ADD COLUMN verification_fingerprint TEXT;
ALTER TABLE social_channel_controls ADD COLUMN verification_expires_at TEXT;
ALTER TABLE social_channel_controls ADD COLUMN verification_by TEXT;
ALTER TABLE social_channel_controls ADD COLUMN verification_error_code TEXT;
ALTER TABLE social_channel_controls ADD COLUMN verification_detail TEXT NOT NULL DEFAULT '{}';
ALTER TABLE social_channel_controls ADD COLUMN webhook_fingerprint TEXT;
ALTER TABLE social_channel_controls ADD COLUMN webhook_verified_at TEXT;
ALTER TABLE social_channel_controls ADD COLUMN send_mode TEXT NOT NULL DEFAULT 'disabled' CHECK(send_mode IN ('disabled','test','live'));
ALTER TABLE social_channel_controls ADD COLUMN test_recipient TEXT;
ALTER TABLE social_channel_controls ADD COLUMN test_passed_at TEXT;
ALTER TABLE social_channel_controls ADD COLUMN test_fingerprint TEXT;
-- Pre-existing controls must be reverified through the new audited workflow.
UPDATE social_channel_controls SET send_enabled=0,emergency_stop=1,verified_at=NULL,epoch=epoch+1;
INSERT OR IGNORE INTO schema_migrations(version) VALUES(9);
