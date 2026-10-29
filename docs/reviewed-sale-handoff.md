# Reviewed Sale composer, templates and multipart handoff

This path transfers the existing Sale Office reviewed WhatsApp composer to CRM transport ownership. It is separate from the approved AI path: neither a reviewed sales draft nor a followup is treated as an AI approval. Tests below use synthetic credentials, isolated databases/buckets and injected transports. They are not proof of live WhatsApp delivery or production readiness.

## Ownership and gates

Sale keeps its contact/deal consent, reviewed draft, current public facts, current media/quote records and scheduler policy. CRM owns the native conversation, agent message, channel verification controls, provider effects and receipts. The existing Sale `sendMessage` action uses this handoff only when `RRS_CHAT_OWNER=crm`; the existing transport remains available for an approved rollback.

Both sides must be enabled explicitly:

- Sale: `RRS_CRM_BRIDGE_ENABLED=true`, `RRS_CHAT_OWNER=crm`, `RRS_CRM_REVIEWED_SEND_ENABLED=true`, fixed HTTPS `RRS_CRM_ORIGIN`, organization/secret and the exact `RRS_CRM_ACTOR_MAP_JSON`.
- CRM: `CRM_BRIDGE_ENABLED=true`, `CRM_REVIEWED_SALE_ENABLED=true`, fixed HTTPS `CRM_REVIEWED_SALE_SOURCE_ORIGIN`, same organization/bridge secret and `CRM_BRIDGE_ALLOWED_MEMBER_IDS`.
- Followups additionally require `RRS_CRM_FOLLOWUPS_ENABLED=true` and the existing scheduler configuration. Ordinary reviewed manual sends do not enable a scheduler.
- CRM still requires current verified channel controls, the exact account and recipient, active approving Admin/Agent, claimed human conversation, unchanged version/customer sequence, recorded consent, appropriate reply window, no opt-out, and no emergency stop. Meta test accounts remain restricted to the configured test recipient.

Keep live sending, schedulers and owner cutover flags disabled until the operator approves the production cutover. No example file contains real credentials or customer numbers.

## Immutable command contract

`POST /api/bridge/reviewed-messages` accepts a version 1 `reviewed-sale-message` envelope with command/conversation/actor IDs, expected version/customer sequence, exact WhatsApp account/remote ID, text, optional exact template, source evidence and optional ordered `parts`. HMAC signatures bind method, full URL, organization, timestamp and body hash. Retries reuse exactly the same command ID and payload hash.

Sale first captures a never-attempted reviewed/queued draft and stores immutable evidence in `rrs_crm_reviewed_messages` with the source commit. Existing provider IDs, sent timestamps, attempted transport records or communication outbox records prevent first capture. The source record is then marked unresolved until CRM returns its durable status. A contact with an unresolved reviewed command cannot acquire a second one.

CRM records `crm_reviewed_sale_commands`, its native message/outbound command and the ordered `crm_reviewed_sale_parts` in one transaction. Each part has an immutable payload/hash, its own attempt UUID, upload ID, provider message ID, lease and status. Unique indexes scope attempt/provider IDs to organization and account. Mutation planners contain no provider side effects.

The fixed source `POST /api/rrs/crm/reviewed-messages/validate` checks the current active reviewer, mapped actor, draft hash, consent, deal/contact relationship, public facts, media/quote readiness, exact mapping and followup review evidence. CRM rechecks this proof before dispatch and during a send. Revocation aborts the transport where possible; an effect already in flight remains uncertain until evidence resolves it.

## Text, templates, files and public links

- The first part is exactly the human-reviewed text. There may be at most 20 additional parts. Duplicate private file IDs are rejected; source references are deduplicated before capture.
- A template must still be APPROVED at Meta with exact name/language, one BODY component, no parameters and exactly the reviewed text. It is the only supported route outside the verified 24-hour reply window. Header/parameter/media template mappings remain unsupported and fail closed.
- Followups require a matching immutable human review audit, an active current reviewer, the unchanged rule/job evidence, scheduler gates and existing frequency/stop policies. A scheduler cannot approve its own draft.
- Private quote/media references become descriptors containing the source record/file IDs, name, MIME, size and SHA-256. They never become public URLs. The source capability `POST /api/rrs/crm/reviewed-messages/file` requires the signed exact command/hash, part index, file ID/hash and nonce, then revalidates the current source approval and original file access before returning bounded bytes.
- Only the fixed configured HTTPS source is called; redirects are not followed. CRM verifies byte count/hash, MIME, source owner restriction and basic container constraints, then uploads bytes to the fixed Meta account `/media` endpoint and sends the returned media ID. No caller-supplied URL is fetched.
- Public HTTP(S) references already present on reviewed source records remain separate text parts when absent from the main text. They are never fetched as media.
- The conservative media allowlist is JPEG/PNG (5,000,000 bytes), MP4 video and MPEG/MP4 audio (16,000,000 bytes), PDF/plain text/DOCX/XLSX (20 MiB source cap). JPEG/PNG color and MP4 H.264/AAC constraints are checked. Other existing uploader formats, including WAV/WebP/HEIC, are blocked pending a verified mapping. The synthetic transport does not prove acceptance by Meta of every permitted codec/container.
- Internal quotations represented by a page link are not files. The existing preflight continues to require a real reviewed PDF/media record.

## Partial results, history and files

Parts execute in order under a single durable group claim. Each part is claimed before an effect. Accepted or ambiguous effects are never automatically retried. A failure/unknown result cancels all later unattempted parts; a group with some accepted parts and some failed/cancelled/unknown parts is `unknown` with `partial_delivery`. Expired claims are quarantined, not resumed blindly.

Receipts are matched by exact organization/account/recipient and individual provider message ID. A signed provider callback can resolve an exact attempt even if it arrives before the HTTP response or after a timeout. Receipt for part 0 does not mark the entire group read. Normal group status is the slowest accepted part; failed/partial groups remain explicit. Late evidence cannot trigger a resend.

After media upload, CRM creates a native attachment with a per-part status and archives the exact source bytes in private CRM storage **before** attempting the customer media message. The shared archive primitive checks the immutable reviewed MIME, byte count and hash, reserves organization quota in a durable pending record, writes the private object, and rechecks source approval and current attachment access before marking it ready. A quota, storage, approval or access failure stops the customer media effect; any earlier accepted text remains an explicit partial result. Failed/cancelled attachment parts are hidden; uncertain sends retain their private archive and remain labelled uncertain. Generic parent-message summaries contain no private filenames or hashes.

Original source R2 files are retained. Subsequent authenticated or signed bridge downloads use the already archived original copy and make no provider request, so Meta transcoding or expiry cannot replace these newly reviewed attachments. Internal, legacy-unknown or sensitive source file scopes remain CRM Admin/Sale owner-only because CRM does not share Sale's complete per-module permission model. Removed messages do not regain attachments because a late receipt arrives. Pre-existing unarchived history still requires the separate migration/archive recovery procedure; pending archive evidence is retained for operator recovery and never authorizes a resend.

Sale receipt polling handles failed delivery, partial results and later confirming receipts; a poll rotates unchanged rows so more than 20 pending entries do not starve later commands. No unknown result is reposted as a fresh command.

## Deploy and rollback

Apply additive CRM migrations through `012_reviewed_sale_parts.sql` (and any later migrations included in the same release) and Sale `0016_crm_reviewed_messages.sql`; retain all prior data and file storage. Deploy both halves with flags off, configure fixed origins and secrets server-side, and test isolated provider transport before any production change. Activate the exact channel/account only after human approval and a documented webhook/owner cutover.

For rollback, disable new reviewed sends first, stop automatic runners and preserve pending/unknown commands and their per-part evidence. Inspect provider receipts before resolving any uncertain effect. Do not re-enable the legacy sender against the same unresolved drafts or clear their IDs/statuses. Revert code/flags only after assigning one transport owner and confirming which commands were accepted; additive tables and old file storage stay in place.

## Verified tests and limits

- `node --import tsx --test tests/reviewed-sale-messages.test.ts`: reviewed text/template, duplicate command, stale generation, current role, source revocation and ambiguity checks.
- `node --import tsx --test tests/reviewed-sale-media.test.ts`: actual signed bridge route acceptance of multipart fields, concurrent per-part claims, ordering, signed private bytes, changed hash/source authorization, partial/unknown outcomes, late/early/wrong-recipient receipts, no blind retry, expired claims, rejected URLs/formats/sizes, native attachment metadata, cross-org/owner-only access, exact-source archival before send, provider-transcoding/expiry independence, quota denial, and review/unsend/owner-scope changes during archival.
- `node --import tsx --test tests/social-media.test.ts`: existing private media archive and permission regression suite.
- Sale `node tests/crm-reviewed-messages.mjs`: real isolated D1/R2 source action and capability, template equality, changed file/reviewer/quote checks, partial/failed/late receipt reflection and polling beyond 20 rows.

These checks do not send WhatsApp messages, validate production secrets, verify live delivery, measure the real provider's latency, or authorize production cutover. Live provider/template/codec acceptance and complete original-history export/restore remain separate acceptance steps.
