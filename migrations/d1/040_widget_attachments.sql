CREATE TABLE web_chat_attachments (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 actor_kind TEXT NOT NULL CHECK(actor_kind IN ('visitor','staff')), actor_key TEXT NOT NULL,
 client_id TEXT NOT NULL, uploaded_by TEXT, conversation_version INTEGER NOT NULL, customer_seq INTEGER NOT NULL,
 filename TEXT NOT NULL, content_type TEXT NOT NULL CHECK(content_type IN ('application/pdf','image/jpeg','image/png')),
 size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 5242880), sha256 TEXT NOT NULL, object_key TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','deleting','expired')),
 message_id TEXT, routing_pending INTEGER NOT NULL DEFAULT 0 CHECK(routing_pending IN (0,1)), created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 UNIQUE(org_id,id), UNIQUE(org_id,conversation_id,actor_key,client_id), UNIQUE(org_id,message_id),
 FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id),
 FOREIGN KEY(org_id,message_id) REFERENCES messages(org_id,id),
 FOREIGN KEY(org_id,uploaded_by) REFERENCES members(org_id,id)
);
CREATE INDEX web_chat_attachment_message ON web_chat_attachments(org_id,conversation_id,message_id,state);
CREATE INDEX web_chat_attachment_cleanup ON web_chat_attachments(org_id,state,expires_at);
CREATE TRIGGER web_chat_attachment_source_immutable BEFORE UPDATE OF org_id,conversation_id,actor_kind,actor_key,client_id,uploaded_by,conversation_version,customer_seq,filename,content_type,size_bytes,sha256,object_key ON web_chat_attachments
BEGIN SELECT RAISE(ABORT,'web attachment source is immutable'); END;
CREATE TRIGGER web_chat_attachment_message_immutable BEFORE UPDATE OF message_id ON web_chat_attachments WHEN OLD.message_id IS NOT NULL AND NEW.message_id IS NOT OLD.message_id
BEGIN SELECT RAISE(ABORT,'web attachment message is immutable'); END;
INSERT INTO schema_migrations(version) VALUES(40);
