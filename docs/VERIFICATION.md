# MVP verification — 25 October 2026

Test environment: Windows, Node.js 24.19.0, pnpm 11.25.0, Next.js 16.4.3 production build, disk-backed PGlite 0.5.11, AI_PROVIDER=demo. This is local acceptance evidence, not a production deployment certification.

## Passed

| Check | Result |
| --- | --- |
| Dependency installation with frozen lockfile | Passed; required esbuild setup explicitly allowed |
| TypeScript and Next production build | Passed, final build has no warnings |
| Migration + Demo seed CLI | Passed against a separate fresh disk database |
| `pnpm test` | 19/19 passed, no skipped tests |
| `pnpm test:api` against final production build | 17/17 passed, no skipped tests; final run 6.56 seconds |
| Browser workflow | Login, streaming chat, consented contact save, Inbox claim/reply, private note, bot suppression, stage/tags edit and Dashboard update passed |
| Browser persistence | Refresh and server restart retained session, transcript, contact and lead stage |
| Mobile public chat | Viewport 390 CSS pixels, no page horizontal overflow |
| Resolved conversation status | Correct closed label and request-staff guidance, no false AI-ready status |

The 19 conversation/provider tests cover five Thai turns with correction from 2 to 10 kits; colloquial Thai and Buddhist year; English export; one missing question; unknown price; discount; dissatisfaction; off-topic; prompt injection; other-customer disclosure; stock; fitment/legal payload; appointment limits; retrieval; fact/unconfirmed separation; repeated greeting; abort; and mocked OpenAI streaming/failure handling.

The 17 real HTTP tests cover unauthorized access, login/logout, Admin/Agent denial, cross-organization read/write/assignee isolation, visitor isolation, internal-note secrecy, public response allowlists, five-turn persistence, message idempotency, unknown-price safety, contact consent, human handoff/release, mid-stream cancellation, simultaneous claim conflict, dashboard/date metrics, KB update/delete/expiry and historical citation snapshots, appointment draft→pending→confirmed→done, CSRF/input validation, member session revocation/disable and last-Admin protection.

Corrections made before final verification: quantity parser could misread a Buddhist year; plural “kits” extraction; stream enqueue needed the conversation row lock; UI EOF handling needed an explicit terminal event; Demo data and Demo provider needed separate labels; completed appointments needed a terminal state; public API fields needed a restricted allowlist; resolved/AI-disabled status labels needed to match server state. The final tests use the corrected source.

## Working implementation versus Demo

Authentication, authorization, API validation, database transactions, persistence, streaming transport, CRM edits, notes, tasks, appointments, KB retrieval, audit and metric calculations are real implementation code. Demo uses actual PostgreSQL semantics through embedded PGlite. No random KPI values are displayed.

Only the conversation generator is a deterministic Demo Adapter when `AI_PROVIDER=demo`; sample accounts and KB are also explicitly Demo. Facts extraction/summary and business commitment rules are deterministic in both modes. The OpenAI adapter is implemented and tested against simulated Responses API event streams; no live API key or paid call was used.

## Not tested / not connected

- External PostgreSQL via pg, multiple replicas, transaction behavior under production load, connection pooling/TLS and backup/restore. Schema uses PostgreSQL SQL and parameterized pg queries, but PGlite tests do not prove all hosted PostgreSQL behavior.
- Live OpenAI account/model availability, Thai response quality across the full corpus, actual provider latency/usage/billing, production token costs. Mock adapter tests verify request/event contracts only.
- Google Sheets, Drive, existing Sale Office, LINE OA, Facebook, WhatsApp, external calendar, email invitation or password-reset delivery. The UI explicitly marks these integrations unavailable.
- Safari/iOS/Android device matrix, formal WCAG audit, independent penetration test, long-duration sessions, concurrent-user load at projected traffic.
- Hosting deployment and GitHub Actions execution. A build/API-check workflow is included; local pass results must not be reported as a remote CI pass.

## Operational limits

- Demo PGlite supports one server process per data directory. Production requires PostgreSQL and HTTPS, secure secrets and initial Admin provisioning.
- Inbox exposes the latest 1,000 conversations and lead/task lists the latest 2,000 records. UI search covers loaded records; metrics aggregate the full database date cohort. Add server pagination/search before long-running high-volume use.
- Daily AI cap is a durable per-organization attempt reservation, not a monthly currency cap. The 2,000 THB/month target has not been proven against paid hosting/channel/LLM invoices.
- One anonymous browser session maps to one lead; unverified phone/email does not silently merge customers across browsers. Visitor history expires at 30 days; actual transcript retention/deletion is an organization policy still to implement operationally.
- Seed creates synthetic accounts and safe public KB only. Integration tests and browser QA generate synthetic customer records; no real customer data or original private sales document is committed.
- Customer appointment confirmation is a request pending staff approval; no availability or calendar collision guarantee.

No merge, production deployment, paid subscription, third-party message or write to the existing Sale Office was performed.
