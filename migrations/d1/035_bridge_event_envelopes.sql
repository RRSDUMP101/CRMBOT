-- Versioned metadata only: retained source events and their payloads stay untouched.
CREATE INDEX crm_bridge_events_aggregate_sequence ON crm_bridge_events(org_id,entity,record_id,sequence);
CREATE TABLE crm_bridge_event_envelopes (
 org_id TEXT NOT NULL,sequence INTEGER NOT NULL,event_id TEXT NOT NULL,
 aggregate_type TEXT NOT NULL,aggregate_id TEXT NOT NULL,aggregate_version INTEGER NOT NULL CHECK(aggregate_version>0),
 correlation_id TEXT NOT NULL,causation_id TEXT,
 PRIMARY KEY(org_id,sequence),UNIQUE(org_id,aggregate_type,aggregate_id,aggregate_version),
 FOREIGN KEY(org_id,sequence) REFERENCES crm_bridge_events(org_id,sequence)
);
CREATE INDEX crm_bridge_event_envelopes_aggregate ON crm_bridge_event_envelopes(org_id,aggregate_type,aggregate_id,sequence);
-- Derive ordinals from the immutable source log, including pre-migration events.
-- This also remains correct while the metadata-only backfill is being applied.
CREATE TRIGGER crm_bridge_envelope_capture AFTER INSERT ON crm_bridge_events
BEGIN
 INSERT OR IGNORE INTO crm_bridge_event_envelopes(org_id,sequence,event_id,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id)
 SELECT NEW.org_id,NEW.sequence,NEW.event_id,NEW.entity,NEW.record_id,
 (SELECT COUNT(*) FROM crm_bridge_events e WHERE e.org_id=NEW.org_id AND e.entity=NEW.entity AND e.record_id=NEW.record_id AND e.sequence<=NEW.sequence),
 NEW.event_id,NULL;
END;
INSERT OR IGNORE INTO crm_bridge_event_envelopes(org_id,sequence,event_id,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id)
SELECT org_id,sequence,event_id,entity,record_id,ROW_NUMBER() OVER(PARTITION BY org_id,entity,record_id ORDER BY sequence),event_id,NULL
FROM crm_bridge_events;
CREATE TRIGGER crm_bridge_event_envelopes_immutable BEFORE UPDATE ON crm_bridge_event_envelopes
BEGIN SELECT RAISE(ABORT,'crm_bridge_envelope_immutable'); END;
CREATE TRIGGER crm_bridge_event_envelopes_retained BEFORE DELETE ON crm_bridge_event_envelopes
BEGIN SELECT RAISE(ABORT,'crm_bridge_envelope_retained'); END;
INSERT INTO schema_migrations(version) VALUES(35);

