-- Undo only the exact grouping the administrator reviewed; a later re-link has a new revision.
ALTER TABLE operator_contact_links ADD COLUMN revision TEXT NOT NULL DEFAULT '';
UPDATE operator_contact_links SET revision=lower(hex(randomblob(16))) WHERE revision='';
-- Keep rollback/rolling old writers compatible: their INSERT omits the new column.
CREATE TRIGGER operator_contact_link_revision_insert AFTER INSERT ON operator_contact_links
WHEN NEW.revision=''
BEGIN
  UPDATE operator_contact_links SET revision=lower(hex(randomblob(16)))
  WHERE org_id=NEW.org_id AND source_lead_id=NEW.source_lead_id;
END;
INSERT OR IGNORE INTO schema_migrations(version) VALUES(91);
