# Chat migration parity and cutover blockers

This branch prepares the CRM to own social conversations and lets Sale Office consume a scoped event stream. It does **not** yet reproduce every existing Sale Office chat workflow. Do not approve production cutover, turn on live sends, or retire the old deployment until the gaps below have an implementation and passing parity tests.

## Implemented and tested locally

`tests/social-channels.test.ts` uses an isolated SQLite database, signed synthetic WhatsApp/LINE/Facebook payloads and injected fake transports. It covers exact account scope, signature rejection, tenant/provider/account/remote identity isolation, concurrent message deduplication, private media references, native and imported LINE unsend tombstones, atomic outbound commands, early/out-of-order receipts, takeover/opt-out/consent/reply-window guards, emergency stop, ambiguous outcomes and bridge sequences. These are fixture results; they do not establish a working provider connection.

Inbound creates a new `waiting_human` conversation when no exact provider identity exists. It never joins people by name or starts an AI reply. Delivery state is stored separately from the native message's generation status. Inbound media types and source metadata remain private provider references; retaining a reference is not proof that its bytes have been archived.

Human text replies require assignment and a matching conversation generation. Sending also requires the configured account, active approving member, environment live flags and a separately verified durable channel control. WhatsApp requires recorded consent and inbound within 24 hours; Messenger requires inbound within 24 hours; LINE requires follow evidence or inbound within seven days. Missing evidence blocks sending. Do not manufacture consent or connection evidence during import.

CRM now provides an Admin-only consent review in the WhatsApp Inbox profile and a scoped HTTPS API. An explicit granted/revoked decision requires an evidence note, confirmation and a current revision. Review cancels queued replies and invalidates old approvals; it never sends a message or clears an existing opt-out. Evidence notes are excluded from Agent audit responses, visitor facts and bridge events. Six isolated SQLite cases cover authorization, concurrent edits, revocation and rollback. This supplies the recording workflow, not proof of any customer's actual consent. Re-enabling an opted-out identity remains outside this workflow, and already-sending/unknown attempts require receipt reconciliation.

The dispatcher claims once. Network failure, timeout, upstream 5xx, redirect, an unidentifiable successful response or an expired sending lease results in `unknown`; it never requeues automatically. A provider acceptance is `submitted`, not `delivered`. An emergency stop aborts the local request but cannot retract a message already accepted by the provider.

## Behavior still requiring parity

| Source behavior | Remaining implementation or verification |
| --- | --- |
| WhatsApp templates and multipart messages (`lib/rrs/whatsapp.ts`) | Discover approved templates with language/exact BODY checks; send outside the 24-hour window only through that verified template path; port private R2-to-provider upload, file/quotation authorization and per-part status aggregation. The new dispatcher sends text only and blocks outside-window replies. |
| AI Approval Center (`lib/integrations/outbox.ts`, `lib/integrations/reply-policy.ts`) | Port job/result/source hashes, exact approved text and recipient, approver role revalidation, facts and claims validation, opt-in evidence, learning mode, provider controls and source revision checks. A human reply command is not a substitute for an approved AI result. |
| Domestic draft/review and retrieval (`lib/rrs/domestic-jobs.ts`, domestic model/schema) | Connect mode-driven drafts, human review, exact model/fact/example versions, revocation, escalation and cancellation to CRM-owned messages and sends. Source `auto` currently creates a human-review item; no production automatic-send caller was found. Product knowledge authoring, YouTube/caption/image/transcription work and its budgets can remain Sale-side. |
| Shared AI message-intent boundary (`lib/ai/`, `lib/integrations/queue.ts`) | Keep general analysis/quotation/export/code jobs, model routing, locks and budgets in Sale. The new authorized transcript adapter feeds retained context, but the message-intent draft/approval/result/source-hash contract still needs a CRM send handoff. CRM's existing website bot is a different workflow. Moving the entire shared AI runtime is not a requirement. |
| Follow-up queue and business context (`lib/integrations/queue.ts`, sales/workflow engines) | Sale now has an explicit, default-off durable inbound reaction queue for stale-job cancellation, waiting state, opt-out and notices, plus scoped CRM transcript context. Sales scheduling can remain Sale-owned. Approved follow-up sends and outbound receipt-to-sales reactions still need their CRM-owned command contract. Imported raw records never activate old queues. |
| Provider administration (`lib/integrations/connections.ts`, `line.ts`) | CRM now has Admin-only GET verification, credential/account/callback fingerprints, expiry, signed callback evidence, restricted test mode, and audited disable/enable controls with a settings panel. Fixtures pass; actual configured account verification and test delivery remain unproven. WhatsApp live enable requires controlled delivered/read evidence, not API acceptance alone. |
| Reconciliation and delivery | Add a reviewed operator flow for unknown/failed outcomes and existing in-flight source attempts. No blind retry is allowed. Exercise Facebook echo-before-response reconciliation, LINE receipt limitations and provider-specific retry behavior with fixtures and controlled account tests. |
| Private media and data recovery | Verify original D1/R2 export completeness, source-to-target mappings, archived object hashes/counts, authenticated retrieval and removed-media behavior. Provider references can expire. A metadata import is not a byte backup or a restore drill. |

## Single owner handoff is not distributed locking

Sale's `RRS_CHAT_OWNER` and CRM's `SOCIAL_CHANNELS_OWNER` are independent deployment settings. Both can be enabled by a configuration mistake. Local guards alone do not prove that only one deployment owns the provider account.

Before enabling CRM: stop old scheduler/live flags; drain and reconcile every source `sending`/`unknown` attempt; freeze the old owner; verify its send routes and inbound POST routes reject work; import and reconcile the final delta; verify the new provider callback/account/HTTPS and then enable one target channel. An explicit shared owner epoch or a verified handoff protocol is required if an atomic cross-host ownership guarantee is desired. Keep the old deployment recoverable.

Rollback must first disable CRM sends, inspect new accepted/unknown attempts and reconcile new messages. Restoring an old snapshot over newer conversations or enabling both owners is not a rollback.

## Validation still required before approval

Run browser/session/SSE tests against the intended staging domain, actual provider signature/verification tests using controlled accounts, private file round trips, restart/replay/lease failure tests and database plus object-store restore checks. Compare source and target counts, timestamps, message/media types, consent, identities, delivery state and suppression tombstones. Do not send customer messages as a migration test. No live credentials, provider sends, database export or production deployment were used by the social adapter fixture suite.
