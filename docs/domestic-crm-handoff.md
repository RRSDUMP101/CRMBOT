# Reviewed domestic LINE / Facebook handoff

CRM receives and stores canonical LINE/Facebook messages, owns channel identities/assignment and performs provider delivery. Sale retains its domestic approved knowledge/model authoring and review runner; it receives scoped read-only CRM projections. This is a bridge for the existing review workflow, not a new autonomous-send mode.

Apply `migrations/d1/013_domestic_review.sql` after previous migrations. Keep `CRM_DOMESTIC_REVIEW_ENABLED=false` until staging review. Configure `CRM_DOMESTIC_SOURCE_ORIGIN` to the exact HTTPS Sale origin; the existing bridge organization/secret and active member allowlist are required. Sale needs migration0017, explicit account/thread/customer mapping and its separate projection/send flags.

Signed endpoints:

- `POST /api/bridge/domestic-messages`: strict version1 `reviewed-domestic-message` envelope with immutable command ID, conversation ID/version/customer sequence, mapped actor, LINE/Facebook account/recipient, exact text, and source message/thread/generation/messageHash/knowledgeHash/reviewer. Unknown fields, templates, arbitrary media and other workspaces/providers are rejected.
- `GET /api/bridge/domestic-messages?commandId=...`: immutable command receipt and outbound status, for status-only recovery after response loss.

The fixed Sale `/api/rrs/crm/domestic/validate` endpoint revalidates exact knowledge/model/fact/example/video versions, review, opt-out and generation using fresh signed nonce proofs. CRM checks proofs before acceptance, claim, external effect and during the in-flight monitor. CRM independently checks active Admin/Agent allowlist, recipient/account, assignment, native customer sequence, channel verification and LINE/Messenger reply windows. Transactional native message + approval evidence + outbound command prevent duplicate effects. Provider ambiguity stays `unknown`; source must never create a fresh command to retry it.

The Sale `/domestic/inbox` retains draft/review controls and links to the exact CRM conversation for claiming. CRM staff can also work in its native inbox. Source commands are not general unsigned browser text. Existing public YouTube links remain reviewed text; a file-upload feature absent from the original domestic sender is not added.

Local validation: `node --import tsx --test tests/reviewed-domestic-messages.test.ts` passes five isolated SQLite tests for LINE/Facebook one-send/idempotency, revoked proofs/generation/assignment/opt-out, current permissions/account/windows, ambiguous provider quarantine and strict/default-off contracts. Sale's paired contract fixture runs its actual D1 draft/review/proof/handoff flow with intercepted bridge responses. No real provider/model call or production change is part of these tests.

Before production, require approved channel-specific staging verification, freeze/drain the old owner, verify imports/counts/watermark, and switch each webhook exactly once. Keep all evidence and original data. Rollback disables new sends first and reconciles queued/unknown commands before returning webhook ownership; never blindly resend. Deployment/browser latency and real channel delivery remain staging acceptance work.
