CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS organizations (
 id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL,
 settings jsonb NOT NULL DEFAULT '{"botName":"RRS ผู้ช่วย AI","personality":"สุภาพ กระชับ ถามครั้งละหนึ่งเรื่อง","businessHours":"ทีมงานจะยืนยันเวลาติดต่อกลับ","handoffRule":"ราคา สต็อก ส่วนลด นัดหมาย และข้อมูลที่ยังไม่ยืนยัน ส่งต่อทีมขาย","aiEnabled":true}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS members (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), name text NOT NULL,
 email text NOT NULL UNIQUE, password_hash text NOT NULL,
 role text NOT NULL CHECK (role IN ('Admin','Agent')), active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id)
);
ALTER TABLE members ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS staff_sessions (
 token_hash text PRIMARY KEY, org_id uuid NOT NULL, member_id uuid NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,member_id) REFERENCES members(org_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS leads (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), name text NOT NULL DEFAULT '',
 phone text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '', tags jsonb NOT NULL DEFAULT '[]',
 interests text NOT NULL DEFAULT '', source text NOT NULL DEFAULT 'website',
 market text NOT NULL DEFAULT 'unknown' CHECK(market IN ('unknown','domestic','export')),
 stage text NOT NULL DEFAULT 'New' CHECK(stage IN ('New','Qualified','Follow-up','Won','Lost')),
 assignee_id uuid, facts jsonb NOT NULL DEFAULT '{}', summary jsonb,
 contact_consent_at timestamptz, contact_consent_version text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id), FOREIGN KEY(org_id,assignee_id) REFERENCES members(org_id,id)
);
CREATE TABLE IF NOT EXISTS conversations (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), lead_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'bot_active' CHECK(status IN ('bot_active','waiting_human','human_active','resolved')),
 version integer NOT NULL DEFAULT 1, assignee_id uuid,
 generating_client_id text, generation_started_at timestamptz,
 first_customer_at timestamptz, first_ai_at timestamptz, handoff_at timestamptz, first_agent_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id), FOREIGN KEY(org_id,lead_id) REFERENCES leads(org_id,id),
 FOREIGN KEY(org_id,assignee_id) REFERENCES members(org_id,id)
);
CREATE TABLE IF NOT EXISTS visitors (
 token_hash text PRIMARY KEY, org_id uuid NOT NULL, conversation_id uuid NOT NULL, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS messages (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, conversation_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('user','assistant','agent','note','system')), content text NOT NULL,
 status text NOT NULL DEFAULT 'complete' CHECK(status IN ('complete','generating','failed','interrupted')),
 client_id text, reply_to_client_id text, generation_version integer,
 sources jsonb NOT NULL DEFAULT '[]', input_tokens integer, output_tokens integer, estimated_cost_usd numeric,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id), UNIQUE(org_id,conversation_id,client_id),
 FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS tasks (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, lead_id uuid NOT NULL, title text NOT NULL,
 due_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','draft','pending','confirmed','cancelled')),
 kind text NOT NULL DEFAULT 'followup' CHECK(kind IN ('followup','appointment')), assignee_id uuid, notes text NOT NULL DEFAULT '',
 visitor_conversation_id uuid, confirmed_by_customer_at timestamptz, confirmed_by_staff_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id), FOREIGN KEY(org_id,lead_id) REFERENCES leads(org_id,id),
 FOREIGN KEY(org_id,assignee_id) REFERENCES members(org_id,id),
 FOREIGN KEY(org_id,visitor_conversation_id) REFERENCES conversations(org_id,id)
);
CREATE TABLE IF NOT EXISTS knowledge (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), title text NOT NULL, content text NOT NULL,
 tags jsonb NOT NULL DEFAULT '[]', status text NOT NULL CHECK(status IN ('draft','published')),
 processing_status text NOT NULL DEFAULT 'ready' CHECK(processing_status IN ('ready','error')), error text,
 version integer NOT NULL DEFAULT 1, source_url text NOT NULL DEFAULT '', expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(org_id,id)
);
CREATE TABLE IF NOT EXISTS audit_events (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), actor_id text NOT NULL,
 action text NOT NULL, entity_id text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS rate_buckets (key text PRIMARY KEY, hits integer NOT NULL DEFAULT 1, reset_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS ai_daily_usage (
 org_id uuid NOT NULL REFERENCES organizations(id), day date NOT NULL, calls integer NOT NULL DEFAULT 0,
 PRIMARY KEY(org_id,day)
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(org_id,conversation_id,created_at);
CREATE INDEX IF NOT EXISTS conversations_org_idx ON conversations(org_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS leads_org_idx ON leads(org_id,created_at);
CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks(org_id,due_at,status);
CREATE INDEX IF NOT EXISTS knowledge_retrieval_idx ON knowledge(org_id,status,processing_status);
CREATE INDEX IF NOT EXISTS audit_org_idx ON audit_events(org_id,created_at DESC);
CREATE INDEX IF NOT EXISTS session_expiry_idx ON staff_sessions(expires_at);
CREATE INDEX IF NOT EXISTS visitor_expiry_idx ON visitors(expires_at);
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT(version) DO NOTHING;
