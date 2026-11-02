# Scoped API and metadata webhooks

Migration `032_public_integrations.sql` is additive. It stores API token hashes, encrypted webhook signing secrets, independent subscription cursors, immutable queued envelopes and bounded attempt logs. No backfill or external delivery happens during migration.

## Enable only the configured capability

- `CRM_PUBLIC_API_ENABLED=true` enables issued API keys.
- `CRM_PUBLIC_WEBHOOKS_ENABLED=true` and `CRM_PUBLIC_WEBHOOK_RUNNER_ENABLED=true` enable the scheduled sender. All three flags default off.
- `CRM_WEBHOOK_ALLOWED_ORIGINS`: JSON array of explicitly trusted HTTPS origins controlled by the intended receivers. No wildcard, IP, local host, custom port, URL credentials, query or fragment. This operator-controlled allowlist is the trust boundary; do not allow domains controlled by untrusted parties or domains that can resolve into your private network.
- `CRM_WEBHOOK_SECRET_KEYS`: JSON key-version → base64-encoded 32-byte encryption key, and `CRM_WEBHOOK_SECRET_KEY_CURRENT`: current version. Previous root keys remain while stored ciphertext uses them. The existing AES-GCM helper authenticates organization, subscription and purpose. These are secret-manager values, never source examples.
- Worker scheduled hook: `runPublicWebhooks(env.DB, env)` from `src/lib/public-integrations.ts`. Queue work is independent of Sale and provider senders.
- Admin UI export: `IntegrationsApiPanel`, shown only to Admin users. All backend administration rechecks the current active Admin session and CSRF origin.

API keys return their secret once. They are hashed at rest, expire within 1–365 days, and have explicit `leads:read` and/or `conversations:read` scopes. Rotation creates a new key and limits the old one to a ten-minute overlap. Revocation or loss of the issuing Admin's authority invalidates a key. Each key permits 60 requests per minute.

## Read API

Send `Authorization: Bearer <issued key>` to HTTPS `GET /api/public/v1/leads` or `GET /api/public/v1/conversations`. Browser Origin and cookies are rejected. Responses use `Cache-Control: private, no-store`.

Optional `limit` is 1–100 (default 50); pass the response `nextCursor` as `after` for the next page. Keys select their organization; callers cannot supply an organization. Leads include contact fields, status and assignment but exclude facts, summaries and internal notes. Conversations include status/assignment/timestamps only. This API has no message body, attachment, send or mutation scope.

## Webhook delivery contract

New subscriptions start paused at the current durable CRM event head, without replaying earlier history. Enabling confirms the destination; events accumulated after creation remain eligible. Only `lead.changed` and `conversation.changed` are supported. The envelope contains version, source event ID, organization, sequence, occurrence time and `data: { id, resource }`. It includes no name, phone, email, message text, internal note or file. A separately scoped API key retrieves authorized data if needed.

Receivers must authenticate before processing, enforce a five-minute timestamp window, and atomically deduplicate `X-RRS-Webhook-Delivery` before applying side effects. Delivery is at least once: a timeout or response loss can cause the **same delivery ID and exact body** to arrive again.

Headers:
- `X-RRS-Webhook-Org`: organization
- `X-RRS-Webhook-Time`: Unix milliseconds
- `X-RRS-Webhook-Delivery`: durable delivery UUID
- `X-RRS-Webhook-Key-Id`: subscription signing version
- `X-RRS-Webhook-Signature`: lowercase HMAC-SHA256 hex using the one-time subscription secret

Canonical signing string is newline-separated: `rrs-webhook-v1`, `POST`, exact destination URL, organization, timestamp, delivery UUID, signing version, SHA256 hex of the exact UTF-8 body. Use constant-time signature comparison. A 2xx response acknowledges receipt. Every retry is newly signed with the same durable delivery ID/body.

The scheduled runner captures up to 50 event rows per subscription, selects at most 10 subscriptions and sends at most 10 deliveries per invocation. It stops starting work after a 25-second soft budget. Every HTTP attempt has a five-second abort deadline, forbids redirects, discards the response body, and logs only status/error codes, IDs and timings. Queue cursor advancement and envelope insertion share the organization transaction. Unique subscription/sequence keys and delivery leases prevent concurrent queue duplication. Backlogs of 1,000 pending rows pause capture without dropping source events.

Network failures, HTTP 408/429 and 5xx retry with bounded exponential delay. Other non-2xx responses become retained dead letters. Five failed attempts require an Admin's explicit retry of that same delivery. Pause, issuer revocation, environment gates and destination allowlists are rechecked before dispatch. Pausing cannot undo an already in-flight request. Signing-secret rotation pauses delivery and reveals the new secret once; install it at the receiver before explicitly resuming.

## Validation and recovery

`node --import tsx --test tests/public-integrations.test.ts tests/migrations.test.ts` uses fresh synthetic SQLite and an in-memory receiver: authentication, scope, tenant isolation, expiry/revoke/rotation, rate limits, privacy allowlists, atomic queue/cursor, concurrent claims, exact HMAC, response loss, redirect rejection, five-second timeout, expired leases, retry exhaustion, manual retry, secret encryption and kill switches.

Disable the runner to stop new attempts; retained events/cursors/deliveries remain. Do not reset a cursor or create new delivery IDs to retry ambiguous outcomes. API and webhook flags do not activate AI or provider customer sends. Fixture results do not assert successful delivery to a production endpoint.

