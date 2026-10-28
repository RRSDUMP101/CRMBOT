# Cloudflare Workers, D1 and R2 deployment

This branch moves the CRM runtime to Workers with a dedicated D1 database and private R2 bucket. It does not modify Sale Office or WhatsApp Hub resources. Legacy PostgreSQL migrations are retained only as historical reference; new deployments use `migrations/d1/` in order.

## Configuration

| Name | Value / purpose |
| --- | --- |
| DB | Dedicated D1 binding; actual identifier belongs in a private deployment config |
| BUCKET | Dedicated private R2 binding |
| SESSION_SECRET | Cloudflare Secret, cryptographically random, at least 32 characters |
| APP_ORIGIN | Verified preview origin first, then https://rrs-crm-terminal.com |
| RRS_WORKERS | true |
| DEMO_MODE | false; deployed Workers refuse Demo storage |
| AI_PROVIDER | disabled until real credentials are available |
| PUBLIC_ORG_SLUG | rrs |
| TRUSTED_IP_HEADER | cf-connecting-ip; accept requests directly from Cloudflare |
| AI_DAILY_CALL_LIMIT | 100 initially; a call-count limit, not a dollar cap |
| FILE_STORAGE_LIMIT_BYTES | 1073741824 initially, per organization |
| OPENAI_API_KEY | Optional Cloudflare Secret, needed to activate OpenAI |
| OPENAI_MODEL | Model available to the configured provider account |

Provision the initial organization and administrator once in D1 using an atomic batch. Store only the salted password hash, never a plaintext password or public default credential. Do not seed Demo accounts, customer records or unapproved knowledge into production.

### Password hashing on deployed Workers

Cloudflare's native PBKDF2 API caps a derivation at 100,000 iterations, while local workerd does not enforce that cap. The app uses the JavaScript PBKDF2 implementation in the pinned `@noble/hashes` package to retain the existing PBKDF2-SHA256 600,000-round format and all already-provisioned passwords. Random salts, constant-time comparison, per-IP/account rate limits and session checks remain in effect. A 3,000 ms Worker CPU ceiling allows headroom for the JavaScript derivation; it is a per-request ceiling, not a plan upgrade or monthly spending cap.

The password regression suite compares against independently generated Node.js PBKDF2 hashes (including Thai text) and rejects wrong passwords while native WebCrypto is mocked to throw the deployed-platform error. The Worker HTTP suite exercises actual login/session behavior. Always check a deployed preview too: a local workerd pass alone did not detect this platform difference.

Runtime source: [Workers PBKDF2 limit](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/limit-enforcer.h) and [Node crypto shares the same limit](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/node/crypto.c%2B%2B).

## Release sequence

1. Verify the target account, existing plan, zone, DNS and certificates. Obtain authorization for incremental charges. Workers Paid has a $5/account/month minimum, not per application; included usage is shared across the account. D1 and R2 overages, AI and messaging providers are additional. Billing alerts are not hard caps.
2. Create the dedicated D1 and private Standard R2 resources. Apply migrations 001–004 only to the new D1 database, after migration and Worker tests pass. Never replay the historical PostgreSQL files against D1.
3. Set Secrets and bind DB/BUCKET. Build and deploy the tested Worker bundle with APP_ORIGIN set to the actual workers.dev URL. No auto-migrations or default accounts run on requests.
4. Verify preview health, password login, authorization, private caching, assets and refresh behavior. Do not run the destructive synthetic acceptance suite against production.
5. Attach apex and www as Worker Custom Domains through Cloudflare so that actual targets and certificates are created by the provider. Preserve unrelated records, especially mail records.
6. Set APP_ORIGIN to the apex. Worker code redirects www and HTTP apex to HTTPS apex with HTTP 308, retaining path/query. Private cookies are HttpOnly/Secure/SameSite; widget visitor cookies are separate.
7. Verify DNS, certificate, redirects and authenticated API again on the real URL. Record any external integration still awaiting credentials; never describe it as tested.

The Worker enforces no-store for CRM, API, widget and cookie responses. Only public build assets/fonts can be cached. Account/zone-wide cache or TLS changes need their own impact review. Worker custom domains terminate HTTPS at Cloudflare; there is no unencrypted origin hop or external Google/Neon backend.

## D1 correctness and recovery

Mutation callbacks read old state and stage writes. A checked guard plus all writes plus organization revision increment execute in one D1 batch. Only the named CAS constraint causes a retry; transport failures are ambiguous and are never retried automatically. Staff status/role is revalidated per retry. External effects and SSE delivery happen outside the planner.

D1 has no interactive PostgreSQL transaction or row locks. Reads after staged writes must be assembled explicitly. Database sessions begin on the primary. Indexes scope CRM queries by organization; Thai literal search uses INSTR because D1 LIKE patterns have a 50-byte limit.

R2 uploads first reserve D1 quota with pending metadata, then store bytes, then mark ready. Pending entries count against quota and cannot be downloaded. An interrupted upload may leave a reservation/object pending. Owner recovery must check the exact object and upload outcome before marking ready or releasing a reservation; never blindly expire a reservation while an upload may still finish. No automatic customer-file deletion is configured.

Set a retention/export policy and perform a backup/restore drill before relying on recovery. D1 Time Travel availability and retention depend on the account plan. R2 is not a substitute for an independently reviewed backup policy.

## Stability and integrations

Workers/D1/R2 avoid the earlier suspended Neon compute and Cloud Run service, but latency and outages are still possible. A paid plan supplies higher limits; it is not an application SLA. Configure external health monitoring after the real domain is active, and measure load with representative synthetic conversations.

External social webhook receivers are not part of the current CRM. Keep existing Sale Office/WhatsApp Hub webhooks untouched. A future receiver must verify signature and size, durably record/queue before acknowledging, process asynchronously with idempotency, bounded retry/backoff and owner-visible failed events. Never wait for the full AI response before acknowledging a provider webhook.

## Security review scope

A focused source review using the security-audit skill covered tenant/authentication boundaries, D1 CAS retries, R2 access/quota and generation fencing. It found and fixed a password-reset/session race, a file schema mismatch, quota enforcement after R2 upload, and stale generation status writes. Functional tests use synthetic principals; this is not a complete penetration test or security certification.

## Rollback

Keep the prior Worker version and migration ledger. A Worker rollback must remain compatible with the D1 schema. Do not roll back to the old PostgreSQL/Cloud Run package against D1. Never drop/recreate production D1 or R2 to repair deployment. Reconcile ambiguous writes by business/event identity before retrying.
