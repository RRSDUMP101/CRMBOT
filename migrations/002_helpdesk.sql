ALTER TABLE conversations ADD COLUMN IF NOT EXISTS customer_message_seq integer NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS customer_seq integer;
WITH numbered AS (
 SELECT id,row_number() OVER (PARTITION BY org_id,conversation_id ORDER BY created_at,id)::integer AS seq
 FROM messages WHERE role='user'
) UPDATE messages SET customer_seq=numbered.seq FROM numbered WHERE messages.id=numbered.id;
UPDATE conversations c SET customer_message_seq=COALESCE((SELECT max(m.customer_seq) FROM messages m WHERE m.org_id=c.org_id AND m.conversation_id=c.id),0);
CREATE UNIQUE INDEX IF NOT EXISTS messages_customer_seq_idx ON messages(org_id,conversation_id,customer_seq);
CREATE INDEX IF NOT EXISTS conversations_inbox_idx ON conversations(org_id,updated_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS conversations_assignment_idx ON conversations(org_id,assignee_id,status);
CREATE TABLE IF NOT EXISTS conversation_reads (
 org_id uuid NOT NULL, conversation_id uuid NOT NULL, member_id uuid NOT NULL,
 last_read_seq integer NOT NULL DEFAULT 0 CHECK(last_read_seq>=0), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,conversation_id,member_id),
 FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id) ON DELETE CASCADE,
 FOREIGN KEY(org_id,member_id) REFERENCES members(org_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS reply_templates (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), title text NOT NULL,
 shortcut text NOT NULL, content text NOT NULL, category text NOT NULL DEFAULT 'ทั่วไป',
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id), UNIQUE(org_id,shortcut)
);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS widget_config jsonb NOT NULL DEFAULT '{"enabled":true,"title":"คุยกับ RRS","greeting":"สวัสดีค่ะ ฉันเป็นผู้ช่วย AI ของ RRS สนใจสอบถามเรื่องไหนคะ","accentColor":"#0f766e","position":"right","allowedOrigins":[]}'::jsonb;
ALTER TABLE visitors ADD COLUMN IF NOT EXISTS context text NOT NULL DEFAULT 'web' CHECK(context IN ('web','widget'));
