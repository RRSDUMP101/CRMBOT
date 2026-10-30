# CRM-owned conversations and Sale Office projection

Status: review/staging implementation; not a completed production migration. No production database, webhook, DNS, credentials or live-send control was changed. Read [remaining parity and release gates](chat-migration-limitations.md) before approving a switch.

## Observed deployment and source

CRM is Next.js 16 / React 19 on Cloudflare Workers through OpenNext, with D1 and private R2. The production checkout is `codex/cloudflare-production` at `d3d5849`; `feat/ai-chatbot-crm-dashboard` at `e1e9502` has the identical tree and is this PR's base. The website bot already streams AI tokens; staff/customer realtime notifications are added here without replacing that token stream.

Sale Office uses Vinext/React, D1 record workspaces and private R2 on Sites. Its GitHub default branch `claude/test-whatsapp-api-system-hq5eaq` at `e4695e4` is newer than the inspected deployed Sites version 34 (`b714db9`). Review that release difference before deployment. Its new projection and migration routes require the companion Sale Office PR. A GitHub merge is not evidence of a deployment.

## Data flow and ownership

1. A verified, account-scoped provider webhook commits its receipt, exact remote identity, customer, conversation, message, provenance and bridge events in one database transaction. Failure rolls everything back. Replayed provider IDs are deduplicated within organization/provider/account scope.
2. D1 triggers append monotonically numbered organization events in the same transaction as each entity mutation. CRM can keep accepting messages while Sale Office is unavailable. No synchronous Sale call sits on the inbound path.
3. Sale fetches bounded pages after its committed cursor, checks contiguous sequence/event identity/hash, commits projection plus cursor atomically, then ACKs. ACKs never delete the replay log. An interrupted ACK is safe to retry.
4. Authorized Sale browsers receive revision-only SSE; ordinary scoped APIs fetch the projection. Open Sale chat views still pull directly. With `CRM_SALE_SYNC_ENABLED=true`, the Worker also sends a signed `wake` to Sale `POST /api/rrs/crm/sync` after any non-GET response below 500 (via `waitUntil`, never on the inbound path) and a `reconcile` from the minute cron, so Sale projects events and delivers queued staff commands while every Sale browser is closed. A failed wake is retried by the next commit or the cron.
5. A Sale reply uses a durable command ID and an explicit server-side staff mapping. CRM revalidates the active staff member and assignment, commits exactly one message/command receipt/outbound intent, then attempts the provider send. A repeat command returns the original effect. A provider timeout or ambiguous result is quarantined as `unknown`, never blindly resent.

CRM owns conversation content, channel identity, delivery state and immutable original-message evidence. Sale owns deals, quotations, sales tasks and local customer records. Exact imported source contact/company/deal IDs reconnect old customers; otherwise deterministic CRM lead mapping creates once. No merge by display name or unverified phone. Existing Sale fields are not overwritten by CRM profile edits: the current CRM profile is visible separately. Explicit remapping uses compare-and-swap plus both market permissions. Source delta imports only update fields that still match their previous imported baseline; concurrent CRM edits are reported as conflicts. See [history migration](chat-history-migration.md).

## API and event contract v1

All bridge calls are server-to-server, fixed to one configured organization. HMAC SHA-256 signs `rrs-bridge-v1`, uppercase method, exact URL including query, organization, millisecond timestamp and SHA-256 of UTF-8 body, joined by newlines. Headers are `X-RRS-Bridge-Org`, `X-RRS-Bridge-Time`, `X-RRS-Bridge-Signature`. Timestamp tolerance is five minutes. HTTPS is mandatory except local fixtures. Browser Origin/cross-site requests are rejected. Rotate credentials through secret storage on both servers; never expose them in browser bundles.

| Endpoint | Contract |
| --- | --- |
| `POST /api/bridge/bootstrap` | `{limit:1..100}`; repeat until `bootstrapComplete`. Explicitly captures existing native rows; migrations do not export customer data automatically. |
| `GET /api/bridge/events?after=0&limit=100` | `{version,orgId,events,after,nextCursor,headSequence,hasMore,bootstrapComplete}`; rejects ahead-of-head cursors. |
| `POST /api/bridge/ack` | `{consumerId,sequence}`; monotonic ACK, bounded by current head. |
| `POST /api/bridge/commands` | `{commandId,conversationId,actorId,action,text?}`; action `claim`, `reply`, `note`, `resolve`. Reuse the same UUID after a lost response; changed payload conflicts. |
| `POST /api/bridge/approved-commands`, `GET …?commandId=…` | Dedicated exact approved-AI text handoff and read-only status, separate from ordinary human commands. Immutable source evidence and fresh signed source checks remain mandatory; see [approved AI contract](approved-ai-handoff.md). |
| `POST /api/bridge/reviewed-messages`, `GET …?commandId=…` | Reviewed Sale composer/follow-up command with exact source review, current business facts, optional approved BODY-only template and bounded private-file manifest. See [reviewed send contract](reviewed-sale-handoff.md). |
| `POST /api/bridge/domestic-messages`, `GET …?commandId=…` | Reviewed Domestic LINE/Facebook text bound to the exact source thread/generation/model/reference hashes and mapped active member; source validation repeats before dispatch. Source knowledge authoring stays Sale-side. |
| `POST /api/bridge/import` | Immutable legacy snapshot, reviewed options, dryRun, cursor and bounded limit. Maximum request 8 MiB. |
| `GET /api/bridge/attachments/:id` | Authenticated private bytes; optional signed `owner=true` only after Sale owner authorization. |
| `POST /api/bridge/dispatch` | Empty object; bounded recovery of eligible queued intents. Does not retry ambiguous provider outcomes. |
| `/api/channels/{whatsapp,line,facebook}` | Provider verification GET where supported and signature/account-verified POST. Gates default off. |
| `/api/admin/events`, `/api/chat/events` | Cookie-authenticated revision notifications, session revalidated each tick. AI text remains on the existing message streaming endpoint. |
| `/api/admin/social-channels/{whatsapp,line,facebook}` | Admin-only HTTPS status; same-origin POST actions `verify`, `disable`, `enable-test`, `enable`. Activation requires `confirm:true`, fresh exact account/callback proof, live environment gates and controlled test evidence. Verification uses provider GETs and leaves sending stopped. |
| `/api/admin/whatsapp-consent/:conversationId` | Admin-only HTTPS GET; same-origin POST `{decision:"granted"\|"revoked",evidenceNote,expectedRevision,confirm:true}`. Evidence note is required, 3–1000 characters. Uses the active cookie member's organization and rejects stale revisions. |
| `/api/admin/reports?from&to&channel&market&assignee&overdueHours` | Read-only staff report (`src/lib/reports.ts`), Asia/Bangkok days, at most 366 days. Admin sees per-agent rows; an Agent sees organization aggregates and only their own row, and may filter `assignee` only to themselves or `unassigned`. Metrics without samples are `null` (UI “ไม่มีข้อมูล”). |
| `/api/admin/reports/export?format=csv&…` | Admin-only CSV of the same aggregates (UTF-8 BOM, RFC 4180, formula-like cells prefixed with `'`, empty cell = no data). Agent display names only; no customer data. Each export writes a `report.exported` audit event. |

Each event is `{version:1,eventId,orgId,sequence,entity,operation:"upsert",record,occurredAt}`. Entity is `lead`, `conversation`, `message`, `socialIdentity`, `messageProvenance`, or `attachment`. `record` uses native snake_case fields, including JSON-encoded column values; consumers must not reinterpret a JSON column as arbitrary executable content. Sequence is organization-wide and thus orders each conversation. Private flags are present on the message itself before provenance arrives. Removed media is a tombstone, not an instruction to expose the old URL.

SSE reconnects after about 25 seconds and checks for changes every 500 ms. It carries no message bodies. Responses use `private, no-store, no-transform`; Cloudflare must not cache authenticated API/SSE responses. The existing browser polling fallback remains. This is not a guaranteed global 2-second production SLA.

## Recording WhatsApp consent evidence

An Admin opens an Inbox conversation's customer profile, reviews the actual consent evidence, selects granted or revoked, enters its source/date/reference, and explicitly confirms. A customer's inbound message does not automatically grant consent. The current fields store when evidence was recorded; the bounded audit note supplies its source and context. Previously imported `optIn=true` plus a nonempty `consentNote` remain their original imported evidence until an explicit review changes the consent fields. GET never manufactures or refreshes consent.

The review is scoped to the exact WhatsApp identity and lead. It rechecks active Admin membership and the organization revision inside the transaction. Concurrent edits return a conflict and require loading the current state and reviewing again. The evidence note lives in an Admin-only audit event; it is omitted from Agent audit snapshots, visitor facts and bridge events. Consent timestamps/version can still appear in the scoped lead record without the note.

Both grant and revoke cancel already queued WhatsApp replies for this lead and advance the related conversation versions. Old approvals cannot become sendable merely because evidence was added; staff review and reply again. Revocation clears the consent fields, interrupts pending generation and leaves existing history intact. Existing `opt_out` flags are never cleared; grant is refused while a linked WhatsApp identity remains opted out. Resubscription needs a separately reviewed evidence flow. Already-sending or unknown attempts remain receipt-driven and may have reached the provider; the UI reports these instead of claiming they were recalled. The review itself makes no provider call and sends no message.

`tests/social-consent.test.ts` exercises active Admin/tenant/origin checks, bounded evidence, stale/concurrent reviews, atomic audit failure rollback, private note handling, opt-out preservation and cancellation of queued/stale approvals on both grant and revoke. All fixtures use synthetic evidence; production customer consent remains an operator verification step.

## Files and permissions

Media uses scoped provider/account references, host allowlists, no redirects, size limits, SHA-256 integrity and private R2 keys. Exact captured source files are fetched through the signed migration proxy, never arbitrary URLs. Owner-only and unknown source permissions fail closed for ordinary staff. Source references and original evidence remain intact; archived bytes and restore completeness require separate verification. Existing organizations, passwords, sessions, native files and business rows are retained. Sale and CRM keep independent logins; users need an authorized CRM account to use CRM screens.

## Local validation

`pnpm typecheck`, `pnpm test`, `pnpm test:migrations`, `pnpm test:integrity`, `pnpm test:deployment`, `pnpm test:chat`, `pnpm build`. Cloudflare packaging and Worker acceptance are separate from Next build: `pnpm cf:build` and `pnpm test:worker` on the supported Linux CI runner. The companion Sale runs `pnpm exec tsc --noEmit`, `pnpm test:chat` and `pnpm build`.

The isolated browser harness used actual route handlers, React screens, SQLite and Miniflare D1 with synthetic accounts. Five normal CRM-commit-to-Sale-DOM samples: 1148, 1277, 997, 1328, 1201 ms; one page load throughout. It also exercised duplicate client IDs, a Sale-originated reply and offline/reconnect catch-up. These results exclude Meta network latency and real authentication/provider verification. Automated tests inject transports; they do not send customer messages.

A subsequent fresh run of the committed paired harness measured 1443 ms for one new native visitor message with one page load. The latest settings UI correctly displayed unconfigured channels with verification/sending disabled and named only missing secret bindings. These are additional local observations, not deployed HTTPS/provider results. The social fixture suite also verifies an exact Facebook echo arriving before the send response: one customer-visible message remains, the duplicate becomes a private audit tombstone, the immutable original event is retained, and mismatched organization/account/recipient/provider IDs never merge.

Reproduce the paired browser check by installing both checkouts, setting `RRS_SALE_CHECKOUT` to the companion source directory, and running `node --import tsx tests/paired-browser.mjs` from CRM. Open loopback ports 39170 and 39171. The harness binds loopback only, uses randomly generated test bridge/session credentials, attaches synthetic authenticated sessions in its local adapter, and rejects external fetches. It dispatches the exact consent and social-admin routes, rewriting CRM requests to an internal `https://crm.test` origin; both screens visibly disclose that HTTPS and cookie context are simulated. This fixture intentionally does not test actual TLS or browser login/cookie transport; the built-Worker HTTP suites cover authentication separately and deployed HTTPS still needs its own check. Its test panel injects a native CRM visitor message, replays its client ID or simulates bridge outage. `GET /fixture/metrics` records commit-to-DOM samples and reconnect catch-up; `GET /fixture/state` verifies counts. Do not deploy this harness or point it at real databases. Stop with Ctrl+C; disposable files stay in ignored `.data/`.

## Sale deal context and D1 limits (2026-10-30)

- Sale-owned deal context (statuses and counts, no prices) is pulled from Sale `GET /api/rrs/crm/outbox` by the minute cron and on staff conversation view (at most every 15 s), committed with its cursor atomically, ACKed after commit and shown read-only in the Inbox customer panel. Visitors never receive it. Flags: `CRM_SALE_CONTEXT_ENABLED`, `CRM_SALE_CONTEXT_ORIGIN`. Migration `015_sale_context.sql`.
- When CRM and Sale run in the same Cloudflare account and zone (for example both on `workers.dev`), Workers cannot `fetch` each other; bind `SALE_SERVICE` (CRM) and `CRM_SERVICE` (Sale) service bindings. URLs, HMAC signatures and checks are unchanged.
- Workers rejects `redirect: 'error'`; server-to-server calls use `redirect: 'manual'` and treat any non-2xx as failure, so redirects are never followed.
- Cloudflare D1 rejects compound SELECTs with more than five terms (local SQLite allows 500). The bridge bootstrap/metadata query now runs per entity; `tests/d1-limits.test.ts` guards all SQL. This was found on a real staging D1, where `/api/bridge/events` previously returned 500.
