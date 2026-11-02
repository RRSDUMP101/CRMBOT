# Instagram receipt contract and activation evidence

Reviewed 2026-11-02. This change implements a narrow receipt parser and synthetic
contract tests. It does **not** record a successful live Instagram test or enable
a provider account. All real provider-send tests are deferred at the user's request.

## Primary evidence and limits

Meta's [official Instagram Postman collection, pinned to commit
3c3853a](https://github.com/fbsamples/messenger-platform-samples/blob/3c3853a84a5d87d2567e75e649655822f535fdf6/postman/instagram-platform-api.postman_collection.json)
contains `Instagram API with Instagram Login / Webhooks / Webhook payload reference /
Messaging seen webhook`. Its example uses `object: instagram`, the account in
`entry[].id` and `recipient.id`, the customer in `sender.id`, and
`read: { mid: <message ID> }`. The subscription field is `messaging_seen`.

That example is under **Instagram Login**. Our existing sender uses **Facebook
Login**, a linked Instagram professional account and Page access token. Meta's
[Facebook Login sample sender](https://github.com/fbsamples/original-coast-clothing-ig/blob/main/services/graph-api.js)
uses the Facebook Graph `/me/messages` route, but does not establish current
receipt semantics for every Graph version. The current Meta developer webhook
pages returned HTTP 429 during this review. We therefore do not claim a completed
Facebook Login/version compatibility check from documentation alone. The parser
accepts only the exact signed `read.mid` shape above; a real receipt from the
configured Facebook Login account and pinned Graph version remains necessary for
activation. If that account produces another shape, it remains unready pending a
verified adapter change.

No Instagram delivery receipt is mapped or verified by this implementation.
Messenger `delivery.mids` and read-watermark expansion are not applied to
Instagram. HTTP acceptance and echoes do not establish delivery or reading.

## Runtime behavior

- The registry verifies the HMAC of the original request bytes and validates all
  account envelopes before writing. A receipt is scoped to organization,
  `instagram` provider, account, customer and exact provider message ID.
- Only a canonical outbound message for that customer can become `read`.
  An inbound message ID or another customer's receipt cannot pass a test.
- Receipts arriving before the send response are retained. Once the response
  supplies the same message ID, the normal settlement path links the receipt.
  A timed-out response without an ID remains `unknown`; customer/body matching
  and automatic resending are prohibited.
- Repeated seen notifications for the same account/customer/message are
  idempotent even when the notification timestamp changes. Unsupported delivery
  and watermark events cannot downgrade an existing read or upgrade another
  message. Signed event history remains available when a conflicting early
  receipt row is repaired against the canonical outbound identity.
- Instagram controlled-test success requires `read`. LINE retains its existing
  submission evidence rule; WhatsApp and Facebook retain delivered/read rules.
  The registry additionally requires a durable, matching outbound command,
  provenance and read receipt from the current connection. A legacy test flag
  alone is insufficient. Credential rotation invalidates the evidence through
  the existing configuration fingerprint checks.
- Existing inbound, live-send, pause, emergency-stop and per-account controls
  remain in force. This change has no migration or default-flag change.

## Validation and remaining live check

`tests/instagram-receipts.test.ts` covers locally signed payloads, real encrypted
registry resolution, activation proof, receipt-before-response ordering,
duplicate delivery, whole-envelope signature/account rejection, tenant isolation,
wrong peer/inbound IDs, unknown transport outcomes, credential rotation and DB
timestamp precision. Provider requests are intercepted by fixtures; unexpected
network access fails the tests.

Related regressions are `tests/social-account-runtime.test.ts`,
`tests/social-channels.test.ts`, `tests/social-accounts.test.ts` and
`tests/social-channel-admin.test.ts`. Run:

```sh
node --import tsx --test tests/instagram-receipts.test.ts tests/social-account-runtime.test.ts tests/social-channels.test.ts tests/social-accounts.test.ts tests/social-channel-admin.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

When the user later authorizes real channel tests, verify the exact linked
Facebook Login account, Graph version, app permission/review and `messaging_seen`
subscription; use the account's controlled recipient; retain the Send API message
ID and the signed matching read event; then run the existing readiness check.
Until that evidence exists, live Instagram delivery/read validation is **NOT RUN**
and the account must not be marked ready from fixtures or an HTTP 200 alone.
