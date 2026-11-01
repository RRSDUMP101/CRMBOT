# Zaapi audit implementation: first release, 1 November 2026

This release extends CRMBOT 200cb18280f21ffecd7e4b655654403737f535da. It is not completion of all F01–F26 audit requirements.

## Implemented

- F12: authenticated Sale-context wake at POST /api/bridge/sale-context/sync. Existing bridge/context flags remain required. One page per wake; 202 explicitly reports catch-up, and scheduled reconciliation remains necessary. It bypasses the general mutation notifier to prevent a Sale/CRM wake loop. ACK recovery and concurrent CAS are tested.
- F15 (partial): committed website/widget inbound messages trigger existing web-scoped flows. Canonical message IDs deduplicate executions. Cancellation uses committed message sequence so delayed older hooks do not cancel newer waits. Handoff/close fences AI generation; web flows cannot dispatch social-provider messages.
- Both new test suites are included in existing package test commands.

## Deliberate limits

Widget inbound hooks run after commit and are best-effort. A crash between message commit and the hook can lose a trigger; durable ingress receipts/reconciliation remain required for lossless F15 acceptance. Once started, existing flow executions/waits remain durable. No new schema migration is included.

Sale producer is a separate change based on e8631cc43948d3064ad80bd8306368ec33169d5d, requiring RRS_CRM_SALE_WAKE_ENABLED plus existing bridge/event flags. A deployed receiver alone does not establish live bidirectional realtime.

The connected Cloudflare account currently has a production CRM and staging Sale only. Production CRM has no bridge configuration or schedules. Do not substitute staging Sale as its production data source, and do not claim realtime activation from this code deployment. Preserve existing runtime bindings and flags; no customer sending is enabled by this release.

## Validation and rollout

Validation uses synthetic isolated data: typecheck, full chat suites, migration/integrity/bot/widget/deployment tests, OpenNext/Workers build, and built Worker HTTP acceptance (auth, org isolation, inbox, public widget and private D1/R2 files). Record actual final results and Cloudflare version IDs in the deployment record, not as guessed values here.

Publish the same tested bundle to CRM staging first, preserving all bindings including secret bindings by inheritance. Check health, login, static assets, unauthorized API response and disabled/unauthorized wake behavior. Then deploy that exact bundle to production and repeat checks. No data migration, seed, provider connection, live sending, or flag activation is part of this code rollout.

Rollback uses the previous Cloudflare version and preserves database/outbox/receipts. Production pre-release version: b36e1cbd-0e0b-464e-b101-60f99c0c7b3b. Disable the new Sale producer flag independently if its wake causes errors; retain cron fallback. Never replay unknown customer sends.

Remaining scope includes multi-account transport, durable widget trigger ingestion, broadcast scheduling, teams/hours, AI lifecycle and additional connectors. Follow the audit matrix and original baseline acceptance targets rather than treating this first release as full Zaapi parity.
