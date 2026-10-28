ALTER TABLE conversations ADD COLUMN customer_message_seq integer NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN customer_seq integer;
WITH numbered AS (
 SELECT id,row_number() OVER (PARTITION BY org_id,conversation_id ORDER BY created_at,id) AS seq
 FROM messages WHERE role='user'
) UPDATE messages SET customer_seq=numbered.seq FROM numbered WHERE messages.id=numbered.id;
UPDATE conversations AS c SET customer_message_seq=COALESCE((SELECT max(m.customer_seq) FROM messages m WHERE m.org_id=c.org_id AND m.conversation_id=c.id),0);
CREATE UNIQUE INDEX IF NOT EXISTS messages_customer_seq_idx ON messages(org_id,conversation_id,customer_seq);
CREATE INDEX IF NOT EXISTS conversations_inbox_idx ON conversations(org_id,updated_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS conversations_assignment_idx ON conversations(org_id,assignee_id,status);
CREATE TABLE IF NOT EXISTS conversation_reads (
 org_id TEXT NOT NULL, conversation_id TEXT NOT NULL, member_id TEXT NOT NULL,
 last_read_seq integer NOT NULL DEFAULT 0 CHECK(last_read_seq>=0), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
 PRIMARY KEY(org_id,conversation_id,member_id),
 FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id) ON DELETE CASCADE,
 FOREIGN KEY(org_id,member_id) REFERENCES members(org_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS reply_templates (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), title text NOT NULL,
 shortcut text NOT NULL, content text NOT NULL, category text NOT NULL DEFAULT 'ทั่วไป',
 version integer NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
 UNIQUE(org_id,id), UNIQUE(org_id,shortcut)
);
ALTER TABLE organizations ADD COLUMN widget_config TEXT NOT NULL DEFAULT '{"enabled":true,"title":"คุยกับ RRS","greeting":"สวัสดีค่ะ ฉันเป็นผู้ช่วย AI ของ RRS สนใจสอบถามเรื่องไหนคะ","accentColor":"#0f766e","position":"right","allowedOrigins":[]}';
ALTER TABLE visitors ADD COLUMN context text NOT NULL DEFAULT 'web' CHECK(context IN ('web','widget'));

INSERT OR IGNORE INTO schema_migrations(version) VALUES(2);
