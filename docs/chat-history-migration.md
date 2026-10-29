# Sale Office chat history import and safe catch-up

This is an operator workflow for the additive CRM bridge/history migrations. It does not change a production webhook, enable a sender, send customer messages, or authorize cutover. Keep the source deployment and its original D1/R2 data until both history and new ingress have been verified.

## Input and identity

The source exporter supplies an immutable version 1 envelope:

```json
{
  "version": 1,
  "sourceSystem": "rrs-sale-office",
  "workspace": "domestic",
  "snapshotId": "operator-capture-id",
  "revision": 42,
  "tailSequence": 120,
  "records": [],
  "webhooks": [],
  "auxiliary": []
}
```

The arrays above are structural examples, not a usable production export. Assemble all pages from the same captured source snapshot; do not concatenate pages from different captures or truncate a large export. The source must capture business records, receipts, auxiliary evidence, revision and `tailSequence` coherently.

`tailSequence` is optional for old baseline exports. It is required to reconcile changed auxiliary evidence because queue, media-cache and outbox rows can change without incrementing the business workspace revision. Once an import has recorded a watermark, later captures cannot omit it or move it backwards. The importer does not infer that the live tail is empty from a captured number: the operator must separately read and compare the source's live head after freezing writers.

Source contact IDs map to CRM leads through deterministic organization/workspace-scoped UUIDs. Exact provider/account/remote-user identities may reuse an existing CRM lead and conversation. Display names never merge customers. Ambiguous phone matches require `phoneContactMap`; existing lead choices require `contactLeadMap` and must belong to the configured CRM organization. WhatsApp requires the verified original phone-number account ID in `whatsappAccountId`, not a guessed account or a secret.

The known WhatsApp inbound/assigned-message pair aliases one native message while both raw source records remain archived. Other conflicting provider-message duplicates fail validation. Every original record and webhook is retained in an immutable, snapshot-scoped archive. Native times are canonical UTC with six fractional digits for stable inbox ordering; original strings remain in the raw archive and message provenance. Timestamps with no explicit timezone or precision finer than CRM microseconds require correction/review instead of an inferred conversion.

## Plan and apply

Set `CRM_BRIDGE_ORG_ID` to the intended organization. Remote operations additionally need `CRM_BRIDGE_ORIGIN` and `CRM_BRIDGE_SECRET` in the operator's environment. Do not put real credentials in the options file, command arguments, repository, or reports. The deployed receiver must have the matching fixed organization/key and `CRM_BRIDGE_ENABLED=true`.

An optional local options file can contain:

```json
{
  "whatsappAccountId": "verified-phone-number-account-id",
  "phoneContactMap": {},
  "contactLeadMap": {}
}
```

```text
node --import tsx scripts/import-legacy-chat.ts --snapshot capture.json --options import-options.json
node --import tsx scripts/import-legacy-chat.ts --snapshot capture.json --options import-options.json --remote-plan
node --import tsx scripts/import-legacy-chat.ts --snapshot capture.json --options import-options.json --apply
```

The first command is an offline plan and does not open a database or fetch files. The remote plan also checks existing target mappings, ownership baselines and conflicts. `--apply` submits signed requests and writes only after a valid remote plan. The CLI currently accepts a snapshot file up to 7 MiB; the signed API accepts a request up to 8 MiB. Larger histories need a reviewed larger-export transport. Splitting a full snapshot into arbitrary partial snapshots is not supported and must not be used to bypass the limit.

Each request commits at most 25 dependency units from one phase. A snapshot is resumable, not one unbounded database transaction. Rerun the same file and options after interruption: the receiver returns the committed cursor and does not duplicate previous rows. Changing a snapshot's content or options under the same ID is rejected. Only one in-progress snapshot per source workspace may advance at a time.

The API returns counts, unresolved file references, warnings, the cursor and completion status. Completion verifies archived/native row counts. It explicitly reports `attachmentBytesVerified:false`, `sourceTailVerified:false`, and `cutoverReady:false`; row-count equality does not prove file bytes, provider behavior or production readiness.

## Safe source deltas

New full snapshots may add messages without replacing earlier rows. To reconcile source changes, explicitly opt in:

```text
node --import tsx scripts/import-legacy-chat.ts --snapshot newer-capture.json --options import-options.json --allow-source-updates --remote-plan
node --import tsx scripts/import-legacy-chat.ts --snapshot newer-capture.json --options import-options.json --allow-source-updates --apply
```

The equivalent JSON option is `"allowSourceUpdates": true`. It does not permit unconditional overwrite.

For every imported native entity, the importer stores the prior normalized source values and the fields actually owned by that import. A changed field may advance only when its current CRM value still matches that baseline, or already equals the requested value. A newer source revision cannot override a conflicting CRM edit. Source record timestamps cannot move backwards. Changes to identity mappings, message parents, account identities or source ownership restrictions require explicit reconciliation.

Source-owned customer name/phone/email and evidenced consent may advance. CRM sales stage, assignment, conversation status, generation owner/version, new CRM messages and existing counters are retained. Existing leads reused through an exact channel identity keep their sales/profile fields; the importer adds only a missing `facts.rrs_sale_office` linkage and will not later claim ownership of their preexisting profile. Historical message content, late receipt/provenance, source opt-out state and source-owned media references can advance under baseline checks. Delivery status cannot move backwards. Owner-only restrictions cannot be relaxed by a history import.

An unsend changes the historical message, provenance, source-owned attachment access state and tombstone in the same database transaction. Source-owned removed attachments retain their object keys for recovery but become inaccessible. An attachment newly added in CRM is not removed merely because it is absent from the old source export. A source record disappearing entirely from a full snapshot is a hard-deletion conflict; it is not interpreted as permission to delete CRM history. A proper tombstone or an independently reviewed reconciliation is required.

Each batch rechecks all planned changes before writing and retries only proven organization-revision conflicts. A later database failure rolls back that batch's business rows, baselines, cursor and bridge events. Earlier completed batches remain recorded. If a real ownership conflict prevents continuation, stop and reconcile it with the operator; do not reset cursors, alter baseline hashes or mark the snapshot complete to force progress.

## Auxiliary evidence and files

Optional `auxiliary` entries are `{table,id,record}`. Accepted tables are `rrs_communication_queue`, `rrs_communication_outbox`, `rrs_uploads`, `rrs_file_scopes`, `ai_jobs`, `ai_results`, `ai_approvals`, `ai_revisions` and `ai_job_steps`. These rows are immutable evidence only: the importer never replays a queue, approval, worker, task or outbound command. Sending/Unknown delivery evidence must be reconciled with the provider before a sender is enabled.

For incoming WhatsApp media, a captured queue `inbound_id -> file_id` takes precedence over an expiring provider reference. Safe captured IDs include `wa-<source UUID>`; they are not all plain UUIDs. Private source files are retrieved only through the configured signed source proxy with exact snapshot/delta reference authorization. Arbitrary external attachment URLs remain unresolved; the importer never crawls them.

An imported local file retains its original WhatsApp/LINE channel label while the exact source reference selects the signed Sale proxy. It does not fall through to a provider-media fetch. Import never creates native archive jobs. New CRM WhatsApp input uses the separately gated [durable archive queue](media-archive-queue.md); migration014 and its scheduler do not backfill old history.

Original internal conversation files and content remain owner-only. Message events carry `source_owner_only` before provenance can arrive on a later event page. Attachment metadata carries `sourceOwnerOnly` and unresolved source scopes carry `sourceScopeUnknown`; these require administrator access. Copying a file does not clear those restrictions. Provider bytes, type, size, hash and original access scope require separate media verification before the file migration can be called complete.

The history importer itself creates no R2 objects. The media archiver reserves a `social_media_archive` row before writing a deterministic private object, then checks its hash and marks it ready. An interrupted copy can leave a pending reservation/object; retry verifies the same hash instead of blindly replacing it. There is no automatic orphan/removed-object deletion job. Keep pending and removed objects during migration and rollback. Cleanup requires a separate reviewed inventory showing which exact objects are unreferenced or covered by an approved retention policy; never delete source R2 objects as part of catch-up or erase bytes merely because a copy request failed.

## Final cutover evidence and rollback

1. Deploy additive code/migrations in staging and validate the source snapshot and bridge authentication. Keep production channel ownership unchanged until the user approves the concrete cutover.
2. Capture/import a baseline, bootstrap all bridge entities, verify counts, media bytes/access and the Sale Office projection. Continue taking newer full captures and applying safe deltas while the source remains authoritative.
3. For the final window, freeze source senders, schedulers and other chat writers. Drain accepted work and reconcile ambiguous sends. During an intentional ingress pause, return retryable failures rather than acknowledging a provider event that was not durably stored. Keep CRM ingress/sending disabled until ownership is switched; avoid two active receivers/senders.
4. Capture the final coherent source snapshot including `tailSequence`, apply it, verify row counts and media, and check the live source log has no events beyond that captured watermark while writers remain frozen. Confirm the CRM event consumer has caught up and both UIs reflect the final transcript. Record the actual counts, hashes, watermark and observed test results.
5. With production approval, switch webhook ownership/epoch, enable the CRM receiver and verify signed test fixtures or designated test-channel behavior. Release any provider retries and confirm that duplicate events do not produce duplicate messages. Enable sending only after its own approved checks. Keep the old deployment available.

If a gate fails, keep or return channel ownership to the verified source path after stopping the other sender. Preserve all newly accepted CRM messages and copy/reconcile them back through the durable bridge; do not restore an old database snapshot over new history. Disable bridge/provider actions rather than deleting imported rows. Keep the permission-aware CRM reader deployed while private imported history exists: rolling back to a build that ignores `source_owner_only` would broaden access. No automated destructive rollback or cleanup is supplied by this importer.

## Verification covered by local tests

Run:

```text
node --import tsx --test tests/chat-bridge.test.ts tests/legacy-chat-import.test.ts
node node_modules/typescript/bin/tsc --noEmit --pretty false
```

The synthetic SQLite suite covers atomic business/outbox rollback; per-organization ordering; replay and bounded bootstrap; signed/foreign-tenant denial; snapshot identity and immutable archives; WhatsApp aliasing; ambiguous contacts; exact-channel reuse; source-delta late receipts; preservation of CRM stage/generation/counters; new-message catch-up; stale revisions/timestamps; CRM-edit rejection; atomic unsend and injected attachment-revocation failure; auxiliary evidence and cached media selection; UTC-microsecond inbox pagination; and owner-only search/preview/read-watermark filtering.

These tests do not establish production provider acceptance, complete production history/file counts, live-tail emptiness, production latency, or actual production cutover. Those remain explicit runtime checks.
