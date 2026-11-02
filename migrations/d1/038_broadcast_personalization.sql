-- Pin the approved rendered content for each recipient; later profile edits never rewrite it.
ALTER TABLE broadcast_recipients ADD COLUMN render_source TEXT NOT NULL DEFAULT '';
ALTER TABLE broadcast_recipients ADD COLUMN rendered_body TEXT NOT NULL DEFAULT '';
ALTER TABLE broadcast_recipients ADD COLUMN rendered_params TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(rendered_params));
ALTER TABLE broadcast_recipients ADD COLUMN rendered_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE broadcast_recipients ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE broadcast_test_sends ADD COLUMN render_source TEXT NOT NULL DEFAULT '';
ALTER TABLE broadcast_test_sends ADD COLUMN rendered_body TEXT NOT NULL DEFAULT '';
ALTER TABLE broadcast_test_sends ADD COLUMN rendered_params TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(rendered_params));
ALTER TABLE broadcast_test_sends ADD COLUMN rendered_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE broadcast_test_sends ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
CREATE TRIGGER broadcast_recipient_render_immutable BEFORE UPDATE OF render_source,rendered_body,rendered_params,rendered_hash,content_hash ON broadcast_recipients
WHEN NEW.render_source IS NOT OLD.render_source OR NEW.rendered_body IS NOT OLD.rendered_body OR NEW.rendered_params IS NOT OLD.rendered_params OR NEW.rendered_hash IS NOT OLD.rendered_hash OR NEW.content_hash IS NOT OLD.content_hash
BEGIN SELECT RAISE(ABORT,'broadcast render snapshot is immutable'); END;
CREATE TRIGGER broadcast_test_render_immutable BEFORE UPDATE OF render_source,rendered_body,rendered_params,rendered_hash,content_hash ON broadcast_test_sends
WHEN NEW.render_source IS NOT OLD.render_source OR NEW.rendered_body IS NOT OLD.rendered_body OR NEW.rendered_params IS NOT OLD.rendered_params OR NEW.rendered_hash IS NOT OLD.rendered_hash OR NEW.content_hash IS NOT OLD.content_hash
BEGIN SELECT RAISE(ABORT,'broadcast render snapshot is immutable'); END;
INSERT INTO schema_migrations(version) VALUES(38);
