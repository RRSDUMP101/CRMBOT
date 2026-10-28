CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'));
CREATE TABLE IF NOT EXISTS organizations (
 id TEXT PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL,
 settings TEXT NOT NULL DEFAULT '{"botName":"RRS ผู้ช่วย AI","personality":"สุภาพ กระชับ ถามครั้งละหนึ่งเรื่อง","businessHours":"ทีมงานจะยืนยันเวลาติดต่อกลับ","handoffRule":"ราคา สต็อก ส่วนลด นัดหมาย และข้อมูลที่ยังไม่ยืนยัน ส่งต่อทีมขาย","aiEnabled":true}',
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')
);
CREATE TABLE IF NOT EXISTS members (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name text NOT NULL,
 email text NOT NULL UNIQUE, password_hash text NOT NULL,
 role text NOT NULL CHECK (role IN ('Admin','Agent')), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
 UNIQUE(org_id,id)
);
CREATE TABLE IF NOT EXISTS staff_sessions (
 token_hash text PRIMARY KEY, org_id TEXT NOT NULL, member_id TEXT NOT NULL,
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
 FOREIGN KEY(org_id,member_id) REFERENCES members(org_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS leads (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name text NOT NULL DEFAULT '',
 phone text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
 interests text NOT NULL DEFAULT '', source text NOT NULL DEFAULT 'website',
 market text NOT NULL DEFAULT 'unknown' CHECK(market IN ('unknown','domestic','export')),
 stage text NOT NULL DEFAULT 'New' CHECK(stage IN ('New','Qualified','Follow-up','Won','Lost')),
 assignee_id TEXT, facts TEXT NOT NULL DEFAULT '{}', summary TEXT,
 contact_consent_at TEXT, contact_consent_version text,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
 UNIQUE(org_id,id), FOREIGN KEY(org_id,assignee_id) REFERENCES members(org_id,id)
);
CREATE TABLE IF NOT EXISTS conversations (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), lead_id TEXT NOT NULL,
 status text NOT NULL DEFAULT 'bot_active' CHECK(status IN ('bot_active','waiting_human','human_active','resolved')),
 version integer NOT NULL DEFAULT 1, assignee_id TEXT,
 generating_client_id text, generation_started_at TEXT,
 first_customer_at TEXT, first_ai_at TEXT, handoff_at TEXT, first_agent_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
 UNIQUE(org_id,id), FOREIGN KEY(org_id,lead_id) REFERENCES leads(org_id,id),
 FOREIGN KEY(org_id,assignee_id) REFERENCES members(org_id,id)
);
CREATE TABLE IF NOT EXISTS visitors (
 token_hash text PRIMARY KEY, org_id TEXT NOT NULL, conversation_id TEXT NOT NULL, expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'), FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS messages (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 role text NOT NULL CHECK(role IN ('user','assistant','agent','note','system')), content text NOT NULL,
 status text NOT NULL DEFAULT 'complete' CHECK(status IN ('complete','generating','failed','interrupted')),
 client_id text, reply_to_client_id text, generation_version integer,
 sources TEXT NOT NULL DEFAULT '[]', input_tokens integer, output_tokens integer, estimated_cost_usd REAL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
 UNIQUE(org_id,id), UNIQUE(org_id,conversation_id,client_id),
 FOREIGN KEY(org_id,conversation_id) REFERENCES conversations(org_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, lead_id TEXT NOT NULL, title text NOT NULL,
 due_at TEXT NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','draft','pending','confirmed','cancelled')),
 kind text NOT NULL DEFAULT 'followup' CHECK(kind IN ('followup','appointment')), assignee_id TEXT, notes text NOT NULL DEFAULT '',
 visitor_conversation_id TEXT, confirmed_by_customer_at TEXT, confirmed_by_staff_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
 UNIQUE(org_id,id), FOREIGN KEY(org_id,lead_id) REFERENCES leads(org_id,id),
 FOREIGN KEY(org_id,assignee_id) REFERENCES members(org_id,id),
 FOREIGN KEY(org_id,visitor_conversation_id) REFERENCES conversations(org_id,id)
);
CREATE TABLE IF NOT EXISTS knowledge (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), title text NOT NULL, content text NOT NULL,
 tags TEXT NOT NULL DEFAULT '[]', status text NOT NULL CHECK(status IN ('draft','published')),
 processing_status text NOT NULL DEFAULT 'ready' CHECK(processing_status IN ('ready','error')), error text,
 version integer NOT NULL DEFAULT 1, source_url text NOT NULL DEFAULT '', expires_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'), UNIQUE(org_id,id)
);
CREATE TABLE IF NOT EXISTS audit_events (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), actor_id text NOT NULL,
 action text NOT NULL, entity_id text NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')
);
CREATE TABLE IF NOT EXISTS rate_buckets (key text PRIMARY KEY, hits integer NOT NULL DEFAULT 1, reset_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_daily_usage (
 org_id TEXT NOT NULL REFERENCES organizations(id), day date NOT NULL, calls integer NOT NULL DEFAULT 0,
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
