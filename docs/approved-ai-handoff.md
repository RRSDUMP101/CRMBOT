# Approved Sale AI text through CRM

This is a default-off implementation tested with isolated databases and fake provider responses. It does not authorize a production switch or establish real provider connectivity. General AI planning, models, budgets, retrieval, result review and business facts remain in Sale Office.

## Ownership and approval

Sale `approveReply` still runs its existing claim policy: exact result payload SHA-256, job/result/approval IDs and versions, active job creator and original owner approver, fresh selected-source hash, customer-visible confirmed facts, exact recipient, opt-in evidence, customer stage, verified inbound window, AI provider readiness, Learning Mode and kill switch. It never substitutes a normal human reply for an AI approval.

With `RRS_CHAT_OWNER=crm` and `RRS_CRM_APPROVED_AI_ENABLED=true`, the original owner approver must map to an active allowed CRM **Admin** and must have claimed the exact CRM WhatsApp conversation. This narrower path does not allow a Sale sales user to act as that Admin. The source contact must already have an exact verified WhatsApp identity and recorded source consent; neither a display name nor CRM's creation of a customer manufactures those facts.

Only a provably unattempted source outbox row (`Approved`, attempt zero, empty attempt ID/provider ID) can receive a first handoff. Legacy sending, unknown, failed-with-attempt or delivered rows require reconciliation and cannot become fresh CRM sends. Once handed off, the old Sale sender refuses that outbox ID even if ownership is switched back. Test messages stay on their explicit test flow and cannot use this AI handoff.

## Wire and persistence

`POST /api/bridge/approved-commands` uses the normal fixed-organization HMAC authentication, with a 512 KB bound. Its version-one `approved-ai-text` envelope carries:

- Immutable source outbox UUID as `commandId`; exact CRM conversation, version, mapped actor, provider account/remote identity and approved text.
- Source system/workspace, job ID/version, result ID/hash and exact original JSON, source hash/revision, approval ID, owner identity and approval time.

CRM re-hashes the original result and checks its customer reply matches the text. It atomically records a native message, normal provider send intent, immutable `crm_approved_ai_commands` evidence and shared command receipt. Same command and hash replays return the same IDs; changed payload conflicts. The original result JSON remains server-only; projection metadata contains only the approval classification and reference IDs/hashes.

`GET /api/bridge/approved-commands?commandId=…` returns IDs, delivery status and a bounded error code. It sends nothing and remains available with the approved-AI send flag disabled. Sale stores its immutable request in `rrs_crm_approved_ai`, recovers lost HTTP replies with this status read, and reconciles subsequent delivery state from the ordinary CRM projection. It never creates a second legacy chat message. Stable completed receipt rows do not occupy the changed-receipt work queue.

## Revalidation at the external-effect boundary

Every eventual dispatch, including the normal queued-intent recovery runner, requests a fresh proof from exactly:

`CRM_APPROVED_AI_SOURCE_ORIGIN + /api/rrs/crm/approved-ai/validate`

The fixed HTTPS origin accepts no credentials/path/query, fetches reject redirects, requests use the same fixed-org HMAC, and responses are capped at 8 KB. The request binds command ID, immutable payload hash and a fresh nonce. Sale rehydrates the actual source records and revalidates all business checks; its response returns only matching IDs/hash/nonce, source revision and check time. It returns no source claims, facts or result content.

CRM checks this proof before claiming, again immediately before the provider request, and during its non-overlapping in-flight monitor. Its own provider account/callback proof, live/test controls, active Admin/allowlist, assignment, generation fence, consent, opt-out and reply-window checks also apply. A source validation failure before a claim leaves the intent queued and blocked; after a claim but before the provider request it cancels the intent. A failed validation during a request aborts locally and leaves any ambiguous outcome `unknown`. Provider acceptance remains `submitted`, not delivery. Unknown outcomes never automatically resend.

This is **not a distributed lock**. Source data can change after the last successful validation and before a provider accepts the request. The monitor reduces that window but cannot retract an accepted message; its network check can also take up to eight seconds. A strict atomic cross-host cutover or approval guarantee would need an explicitly designed shared lease/ownership protocol. No such guarantee is claimed here.

## Configuration and rollback

CRM requires migration 010, existing migrations 001–009, the configured bridge organization/secret/member allowlist, `CRM_APPROVED_AI_ENABLED=true`, and a fixed `CRM_APPROVED_AI_SOURCE_ORIGIN`. Sale requires migration 0015, its existing bridge/actor mapping, `RRS_CHAT_OWNER=crm`, and `RRS_CRM_APPROVED_AI_ENABLED=true`. All new send flags default off. Existing AI provider controls remain active in Sale; the old Sale WhatsApp transport stays off. CRM channel verification and consent gates remain independent.

Before cutover, retain full D1 backups including both new immutable evidence tables, reconcile old sending/unknown attempts, verify the exact recipient/account/assignment and run controlled staging acceptance. Audit-only backups or restored queue rows must never be replayed. To stop the new flow, disable its send flags and CRM channel sending, retain all rows and reconcile accepted/unknown outcomes. Do not route a handed-off ID back through the old sender or overwrite newer conversation data.

## Actual local checks

- `node --import tsx --test tests/approved-ai.test.ts`: seven SQLite tests for duplicate/lost-reply identity, nonce/redirect/source/result tamper, atomic rollback, tenant/consent/Admin/version gates, source and allowlist changes, unknown outcomes and source revocation during an in-flight fake send.
- Set `RRS_SALE_CHECKOUT` to the companion checkout, then `node --import tsx tests/approved-ai-paired.mjs`: five paired checks using actual Sale `approveReply`/`decideApproval`/context validation, signed proof handlers, CRM enqueue/dispatch, Miniflare D1 and SQLite. Only provider responses are fake; all other external URLs are rejected. It tests complete approval handoff, lost-response recovery, changed source/removed owner/Learning Mode, opt-out/unknown outcome, and rejection of legacy attempted deliveries.
- Existing Sale `tests/communication-connections.mjs`: 24 fake-transport regression checks passed for the retained legacy flow.

Real provider delivery, staging HTTPS, production customer consent evidence, restore drills and cross-host failure windows remain unverified. The user's current instruction is to continue simulated testing only.
