# Historical verification record

The results below predate the D1/R2 rewrite. They do not establish that the current release passed; use the current PR checks and deployment report for that.

# MVP verification — 27 October 2026

Test environment: Windows, Node.js 24.19.0, pnpm 11.25.0, Next.js 16.4.3 production build, disk-backed PGlite 0.5.11, `AI_PROVIDER=demo`. This is local acceptance evidence, not certification of a production deployment or external service connection.

## Automated verification

The final frozen-code run passed **65 automated checks: 29 unit/provider/widget, 4 migration, 17 existing API and 15 new helpdesk/widget HTTP checks**, with none skipped. The final production build passed; both HTTP suites were then rerun sequentially against that rebuilt application. Remote CI status is reported by the PR checks; this document records local evidence.

| Check | Result |
| --- | --- |
| TypeScript and Next production build | Passed on the final frozen code |
| `pnpm test` | 29/29 passed, including Thai domestic-market, literal greeting-substitution and widget runtime concurrency regressions |
| `pnpm test:migrations` | 4/4 passed in a separate synthetic database, including the formal command rerun |
| `pnpm test:api` | 17/17 passed against the final 27 October production build; 5.91 seconds |
| `pnpm test:helpdesk` | 15/15 passed against the same final production server; 2.57 seconds |

Run the two HTTP suites sequentially while browser mutations are paused. They create synthetic records; the helpdesk suite temporarily changes widget configuration and restores the original configuration in its cleanup hook. Migration tests use their own ignored `.data/` directory and do not open the app's configured database.

The first helpdesk run passed 14/15 checks and found that the global CSP overrode `/widget`'s dynamic framing policy, blocking the intended iframe. The global CSP was excluded from the exact widget route, the application was rebuilt, and all 15 affected HTTP checks passed. They verify that `/widget` permits only itself and configured embedding origins while the CRM root still sends `frame-ancestors 'none'`. After the final keyboard and widget concurrency corrections, both HTTP suites passed again on the final build as recorded above.

### Coverage

The **20 conversation/provider tests** cover five Thai turns with correction from 2 to 10 kits; colloquial Thai and Buddhist year; English export; domestic conversational wording such as “ใช้งานในไทย”; one missing question; unknown price; discount; dissatisfaction; off-topic; prompt injection; other-customer disclosure; stock; fitment/legal payload; appointment limits; retrieval; fact/unconfirmed separation; repeated greeting; abort; and mocked OpenAI streaming/failure handling.

The **6 widget unit checks** cover standalone JavaScript parsing, safe JSON configuration that cannot terminate its script element, exclusion of internal configuration, literal dollar replacement markers in administrator text, loader credential/message-source behavior, and locally shipped Thai/Latin WOFF2 files with the font license.

The **3 widget runtime checks** execute the widget script in a controlled DOM/network harness: concurrent first-contact/handoff requests share one session and wait for cookie verification; older polling responses cannot rewind messages or epochs and failed replies remain visibly incomplete; cancelled stream events and cleanup cannot clear a newer send. These checks do not replace real browser cookie-policy and cross-site execution tests.

The **4 migration checks** cover upgrading schema 001 to 002 without losing customers or historical messages; ordered inbound-message backfill; per-member monotonic read watermarks surviving migration reruns; cursor timestamps preserving PostgreSQL microseconds and UUID ties; and continued inbound sequencing with idempotent retries.

The **17 existing real HTTP tests** cover unauthorized access, login/logout, Admin/Agent denial, cross-organization read/write/assignee isolation, visitor isolation, internal-note secrecy, public response allowlists, five-turn persistence, message idempotency, unknown-price safety, contact consent, human handoff/release, mid-stream cancellation, simultaneous claim conflict, dashboard/date metrics, KB update/delete/expiry and historical citation snapshots, appointment draft→pending→confirmed→done, CSRF/input validation, member session revocation/disable and last-Admin protection.

The **15 new helpdesk/widget HTTP tests** cover:

- Admin reply-template creation, update, version conflict and deletion; Agent read/use permissions; organization isolation; and the requirement for an explicit staff-send action.
- Per-member unread counts, duplicate client IDs, stale read watermarks, and rejection of another conversation's, another organization's or internal-note message identifiers.
- Full customer-name and older-message search across cursor pages; queue, tag and owner filters; global queue counts; and invalid-query rejection.
- New messages reopening resolved conversations into `waiting_human` without restarting AI; duplicate messages leaving the conversation closed.
- Admin-only widget configuration, exact HTTPS-origin/color validation, public configuration redaction, allowlisted config CORS and rejection of cross-origin chat mutations.
- Dynamic widget framing policy versus CRM framing protection; separate regular/widget session contexts and cookie attributes; and disabling the widget while regular website chat remains usable.

## Browser verification

The **27 October browser acceptance pass and final rebuilt-version smoke check passed**. The following behavior was observed during the acceptance pass:

- Desktop Inbox at 1,440 CSS pixels, customer profile, and mobile Inbox/profile/return navigation at 390 CSS pixels.
- Same-origin widget preview: two streaming conversational turns, consented contact-form save, human handoff, and mobile history retained after reload at 390 CSS pixels.
- Reply-template creation, insertion as an editable draft and explicit manual sending; internal staff notes remained private.
- New customer messages after staff handoff did not trigger AI replies; changing a lead to Qualified worked.
- Widget title/color save and installation-code copying worked.

After the final keyboard/concurrency correction build, the following smoke checks also passed:

- At 1,440 CSS pixels, Inbox search, customer profile and requirement summary worked; the Thai phrase “ใช้งานในไทย” was recognized as the domestic market.
- At 390 CSS pixels, the Dashboard document width was 375 pixels within the viewport, with no horizontal page overflow. The mobile menu closed with Escape and restored focus; profile drawer/edit-dialog Tab handling and two successive Escape actions returned focus correctly.
- Reloading the widget iframe retained history and staff-handoff status. A new customer message was persisted and did not trigger an AI response while staff owned the conversation.
- No console errors or warnings were observed during the final smoke checks.

Local screenshots are saved in the task workspace as `outputs/RRS_Inbox_2026-10-27.png` and `outputs/RRS_Live_Chat_Mobile_2026-10-27.png`. These checks do not validate real cross-site production embedding, a formal accessibility audit or the full device matrix.

Historical **25 October** browser evidence is retained: login, public streaming chat, consented contact save, Inbox claim/reply, private note, bot suppression, stage/tag edits and Dashboard updates passed; refresh and server restart retained session/transcript/contact/stage; the public chat had no horizontal page overflow at a 390 CSS-pixel viewport; resolved conversations showed the closed state. These results concern the earlier interface and are not a substitute for the new UI's browser pass.

## Working implementation versus Demo

Authentication, authorization, API validation, database transactions, persistence, streaming transport, CRM edits, internal notes, tasks, appointments, KB retrieval, audit and metric calculations are real implementation code. The new server-side inbox search/pagination, per-member unread state, shared reply templates, widget configuration and embeddable chat use the same persisted and tenant-scoped backend. No random KPI values are displayed.

The deterministic Demo Adapter is used when `AI_PROVIDER=demo`; sample accounts and KB are also explicitly Demo. Facts extraction/summary and business commitment rules remain deterministic in both provider modes. The OpenAI adapter is implemented and tested with simulated Responses API events; no live API key or paid call was used. Embedded PGlite exercises PostgreSQL semantics but is not a hosted PostgreSQL deployment.

The widget has an appearance-only preview and a separate live preview that writes actual Demo conversations. `/widget.js` fetches public configuration without staff credentials and loads `/widget` in an iframe. Chat mutations originate within that same-origin iframe; enabling an embedding website does not grant it cross-origin access to chat mutation APIs.

## Reference design and font

References checked on **27 October 2026**:

- [Zaapi Thai website](https://www.zaapi.com/th) and [Helpdesk](https://www.zaapi.com/th/product/unified-inbox): work queues, conversation lists and customer context informed the RRS layout. This is an RRS implementation, not a Zaapi integration or a claim of feature parity.
- [Zaapi FAQ EP8 — website Live Chat](https://www.youtube.com/watch?v=zhsOe-NOdIQ): the observed title was “[TH] FAQ Zaapi EP8 - คู่มือการใช้งาน Zaapi | วิธีเพิ่ม Live Chat บนเว็บไซต์ของคุณในไม่กี่นาที”, published 12 September 2025. Inspected chapter references: 0:58 customization, 2:23 installation and 2:39 widget example. No complete subtitle transcript was used, and no pricing claims were adopted.
- `@fontsource-variable/noto-sans-thai@5.3.0` supplies self-hosted Noto Sans Thai Variable. The widget's Thai/Latin subsets and SIL Open Font License 1.1 are included in `public/fonts/`; runtime font loading does not require a third-party font CDN.

## Not tested / not connected

- External PostgreSQL via `pg`, multiple replicas, transaction behavior under production load, connection pooling/TLS and backup/restore. PGlite tests do not prove every hosted PostgreSQL behavior.
- Live OpenAI account/model availability, Thai quality across the full intended corpus, provider latency/usage/billing and actual production token costs. Mock tests verify request/event contracts only.
- Google Sheets, Drive, existing Sale Office, LINE OA, Facebook, WhatsApp, external calendar, email invitation or password-reset delivery. These integrations remain explicitly unconnected.
- Real cross-site embedding on production HTTPS domains and browser-specific third-party/partitioned-cookie behavior. HTTP tests confirm the intended `HttpOnly; SameSite=None; Secure; Partitioned` widget cookie and separate `SameSite=Lax` regular cookie, but a Node cookie jar does not enforce browser cookie policy. Same-origin preview success is not cross-site proof; use the full-chat link if an intended browser blocks embedded sessions.
- Complete updated mobile/browser matrix, Safari/iOS/Android devices, formal WCAG audit, independent penetration testing, long-duration sessions and concurrent-user load at projected traffic.
- Hosting deployment. Remote CI status is reported by the PR checks; this document records local evidence.

## Operational limits

- Demo PGlite supports one server process per data directory. Production requires PostgreSQL, HTTPS, secure secrets and initial Admin provisioning.
- Inbox now searches the full tenant-scoped history on the server and uses cursor pagination; the previous 1,000-conversation UI limit no longer applies to the Inbox. CRM and task lists still expose up to 2,000 records and filter their loaded records. Dashboard metrics aggregate the full selected database date cohort.
- Shared reply templates are capped at 200 per organization; widget allowed origins are capped at 10. An origin is exact: scheme, hostname and optional port; `www` is separate, and wildcard/path entries are rejected.
- Daily AI cap is a durable per-organization attempt reservation, not a monthly currency cap. The 2,000 THB/month target has not been verified against paid hosting/channel/LLM invoices.
- One anonymous browser session maps to one lead; unverified phone/email does not silently merge customers across browsers. Visitor session access expires at 30 days; transcript retention/deletion remains an organization policy to implement operationally.
- Seed and tests use synthetic accounts, customer records and safe public KB. No real customer data or original private sales document is committed.
- Customer appointment submission remains pending staff approval; there is no external availability or calendar-collision guarantee.

No merge, production deployment, paid subscription, third-party customer message or write to the existing Sale Office/business website was performed. The widget has not been installed on `rungruengdump101.com` by this work.

