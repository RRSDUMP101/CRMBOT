# Durable native WhatsApp attachment archival

Apply additive D1 migration `014_inbound_media_archive.sql` after 001–013. It creates an organization-scoped job table and attachment key index, without modifying old messages or enqueueing historical files. A verified native WhatsApp inbound transaction now commits its message, provenance, attachment and archive job together. Replayed provider events cannot create duplicate jobs. LINE/Facebook and imported evidence do not enter this WhatsApp queue. No archive operation sends a customer message.

`SOCIAL_MEDIA_ARCHIVE_ENABLED=false` is the default. Activation also requires `SOCIAL_CHANNELS_OWNER=crm`, `SOCIAL_INBOUND_ENABLED=true`, the correct organization/account and access token. The current owner, account, native inbound provenance, private scope and removal state are rechecked around every copy. Source-import metadata and reviewed outgoing attachments cannot become native jobs.

After an inbound webhook commits, Workers `waitUntil` starts one bounded archive attempt. A one-minute scheduled Worker handler resumes pending work independently of browser sessions. The handler invokes the application's fixed `/api/internal/media-archive` route internally; it does not make an HTTP request to a public relay. A purpose-bound HMAC over method, exact HTTPS URL, timestamp and exact body uses the existing server-only SESSION_SECRET. Requests expire after 60 seconds. Replays can only claim eligible idempotent archive jobs; they cannot enqueue messages or resend anything.

Each job has a 90-second lease and unique claim token. Failed reads retry after 15 seconds with exponential backoff capped at one hour, up to eight claims. Crashed leases are recovered. Integrity/size failures stop; removed or private/non-native inputs cancel. Unavailable ownership/account blocks without fetching. Errors contain stable codes, never tokens, signed URLs or provider response bodies. Admin can explicitly retry failed/retry/blocked jobs after fixing the cause. Existing source originals, pending reservations and removed objects are retained; no deletion job is introduced.

WhatsApp metadata must supply a bounded positive file size, MIME and SHA-256. Downloaded bytes must match all three before any archive reservation. The shared archive primitive reserves quota transactionally (including pending reservations), writes a deterministic private object, checks existing bytes during recovery and rechecks access before marking ready. An interrupted object remains pending. Download checks removal and owner restrictions again after the final R2 read, cancelling its response body if access changed.

Imported local Sale files retain their channel identity but use the signed source-file capability identified by immutable `sourceSystem`, workspace and exact original reference. They do not require the former provider's credentials to read a retained source file. Unknown source permissions remain Admin-only. This fixes cached WhatsApp and local LINE history without converting imports into executable provider jobs. Source-reference completeness and byte verification remain separate migration gates.

## Deployment configuration and verification

The checked-in Wrangler template has `triggers.crons=[]` and the archive flag false. Preserve the existing DB, BUCKET, SESSION_SECRET and unrelated configuration. Use an ignored deployment JSON with the real existing binding IDs, then generate/check the schedule:

```sh
node scripts/media-archive-deployment.mjs --configure .wrangler/release-input.json .wrangler/release.json
node scripts/media-archive-deployment.mjs --check .wrangler/release.json
wrangler deploy --config .wrangler/release.json
```

The generator adds `* * * * *` only when archival is explicitly enabled with CRM inbound ownership; otherwise it removes that schedule and preserves unrelated fields/schedules. It never overwrites an existing output. Deploying flags off does not install an active archive schedule. After activation, verify the actual Worker trigger and binding values through Cloudflare, commit one **synthetic staging** inbound media event, and confirm it reaches `archived` without a download request. Do not count a configured local cron as evidence that a production trigger is running.

Authenticated Admin inspection: `GET /api/admin/media-archive` returns the latest 100 scoped job IDs, status, attempts, next-attempt time and error code. Same-origin Admin retry: `POST /api/admin/media-archive/retry` with `{ "attachmentId": "<uuid>" }`. Current Admin membership and organization are checked. Conversation attachments display queued/working/retry/blocked/failed/archived states through existing realtime metadata events. Non-Admin users do not receive internal error codes or private attachment scopes.

For rollback, disable the archive flag and remove only its one-minute trigger, then preserve all queue rows and private objects. The old application can ignore this additive schema. Restore ownership only after the normal channel handoff checks; do not replay historical source queues or delete evidence to reset a job.

## Tests and limits

`tests/media-archive-queue.test.ts` exercises actual signed webhook ingestion, atomic rollback on queue failure, duplicate delivery, concurrent claims, lease recovery, outage/backoff, provider metadata/hash/size/MIME errors, attempt limits, current owner/account changes, removal, private scopes, Admin retry, cross-organization denial, runner MAC validation and deployment schedule generation. `social-media.test.ts` checks private storage, imported reference safeguards and access changes during final object read. `legacy-chat-import.test.ts` imports cached WhatsApp and LINE local files and downloads verified bytes through a fake signed source endpoint.

All transport tests use isolated data and injected responses. This does not prove live provider delivery, production trigger execution or full historical file coverage. Native archival has a 25 MiB byte ceiling and finite retries; expired files still require operator recovery from retained source evidence. Provider webhooks are acknowledged after durable metadata/job commit, independently of the background copy.
