# Broadcast recipient text and private media

Apply append-only D1 migrations `038_broadcast_personalization.sql` and `039_broadcast_media.sql` before deploying this code. Existing static text campaigns retain their delivery state and legacy approvals; they are not resent. Neither migration sends messages.

## Recipient text

The Admin editor accepts `{{name}}`, `{{first_name}}`, `{{market}}` and `{{stage}}` in message text or approved WhatsApp template parameter values. Expansion is plain text, once only; values are never interpreted as expressions or another template. Missing names, invalid parameters and messages over the channel limit are excluded with a reason. Market and stage values are the stored CRM values.

Preview returns actual rendered samples, eligibility counts and `audienceHash`. Launch accepts `expectedAudienceHash` with the existing version/count confirmation. The UI always supplies it; personalized or media campaigns require it. A different recipient identity, destination, lead, conversation, rendered value, campaign revision or selected asset invalidates approval even when the recipient count stays the same. The current source/asset revision must also have a successful test to the configured test recipient.

Launch pins each recipient's body, template parameters, source and hashes in the same organization CAS batch. Immutable snapshot triggers prevent later rewrites. Profile edits after launch do not alter approved text. Consent, suppression, identity linkage, recipient replies, account identity, active Admin approval, pause, emergency stop and credentials are still checked during sending. All messages use the existing single outbound-command dispatcher. Unknown submission outcomes are never resent.

## Private campaign assets

`CRM_BROADCAST_MEDIA_ENABLED=true` enables uploads and media dispatch; it defaults off. Sending also requires the existing `BROADCAST_ENABLED`, selected account verification/live gates and recipient eligibility. Automatic scheduled sending additionally requires `BROADCAST_RUNNER_ENABLED` and the minute Worker cron. Enabling media alone does not authorize a campaign.

Draft-only uploads use `POST /api/admin/broadcasts/:id/asset` with raw bytes, `Content-Type`, URI-encoded `x-file-name` and `x-campaign-version`. Upload/removal advances the campaign revision and requires a fresh preview and test. Removal uses `POST /:id/remove-asset` with `expectedVersion`; authenticated Admin download uses `GET /:id/assets/:assetId`.

LINE supports PNG/JPEG up to 1 MB, delivering optional text plus the image in one provider message request. WhatsApp supports PNG/JPEG up to 5 MB or PDF up to 10 MiB with a caption of at most 1,024 characters, within its ordinary customer-service window. Campaign assets currently apply to text campaigns; provider-approved media templates are not constructed or impersonated.

Assets are scoped to organization/campaign/provider/account, validated by container, size and SHA-256, and stored in private R2. A separate per-command manifest binds the approved asset and caption. WhatsApp uploads private bytes to the exact configured account before the guarded message POST. LINE receives a random, short-lived, attempt-bound grant with an access budget; pause, revocation, consent changes, token rotation or expiry revoke access. Completed receipts may fetch their already-approved image during that short grant lifetime; this does not reopen sending. Approved assets remain retained for audit; only abandoned unselected assets without approved commands are eligible for bounded cleanup. The default campaign-asset quota is 100 MiB per organization (`BROADCAST_MEDIA_STORAGE_LIMIT_BYTES`).

## Verification

Run `node --import tsx --test tests/broadcast.test.ts tests/broadcast-runtime.test.ts tests/broadcast-media.test.ts tests/human-attachments.test.ts`. The fixtures use isolated SQLite/private storage and mock provider transports. They cover recipient snapshots and hash changes, template parameters, current account resolution/rotation, pause fences, media validation and grant access, and preservation of human attachment behavior. They do not send to customers or real providers.
