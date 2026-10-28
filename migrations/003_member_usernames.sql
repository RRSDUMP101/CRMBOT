ALTER TABLE members ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE members ADD CONSTRAINT members_username_format CHECK (
  username IS NULL OR username ~ '^[a-z0-9][a-z0-9_.-]{2,63}$'
);
CREATE UNIQUE INDEX IF NOT EXISTS members_username_unique_idx ON members(username) WHERE username IS NOT NULL;
