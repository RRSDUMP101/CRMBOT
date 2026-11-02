-- Runtime is opt-in per account and globally. Registry credentials never enable sends by themselves.
ALTER TABLE social_accounts ADD COLUMN runtime_inbound_enabled INTEGER NOT NULL DEFAULT 0 CHECK(runtime_inbound_enabled IN (0,1));
ALTER TABLE social_accounts ADD COLUMN runtime_live_enabled INTEGER NOT NULL DEFAULT 0 CHECK(runtime_live_enabled IN (0,1));
ALTER TABLE social_accounts ADD COLUMN runtime_test_recipient TEXT NOT NULL DEFAULT '';
INSERT OR IGNORE INTO schema_migrations(version) VALUES(31);
