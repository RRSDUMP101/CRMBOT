# Cloud Run + Cloudflare deployment

This branch packages the existing Next.js app for Google Cloud Run, with a small Cloudflare Worker forwarding the website/API over HTTPS. Neon provides PostgreSQL. The frontend and API remain on one public origin, so staff cookies and CSRF checks remain same-origin.

## Release status

This change prepares the Cloud Run package and Cloudflare proxy. A live Cloud Run deployment, production secrets, preview URL and domain checks are still required before release. The public repository intentionally contains no cloud account, database project/branch identifiers, connection strings or credentials.

## Runtime configuration

Use Google Secret Manager for these values, with Secret Accessor granted only on the specific secrets to the runtime service account:

| Secret / variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Verified Neon **pooled** connection URI for a dedicated application role, with `sslmode=verify-full` |
| `SESSION_SECRET` | Random value of at least 32 characters; stable across revisions |
| `EDGE_PROXY_SECRET` | Random value of at least 32 characters, shared with the Cloudflare Worker |
| `OPENAI_API_KEY` | Needed only when enabling the existing OpenAI provider |
| `APP_ORIGIN` | Verified Cloudflare preview origin first; then `https://rrs-crm-terminal.com` |
| `DEMO_MODE` | `false` |
| `RRS_EDGE_PROXY_REQUIRED` | `true` |
| `TRUSTED_IP_HEADER` | `x-rrs-client-ip` |
| `AI_PROVIDER` | `disabled` until a real provider credential is configured |
| `PUBLIC_ORG_SLUG` | `rrs` |

The Worker needs only `BACKEND_ORIGIN` (the exact HTTPS `.run.app` origin returned by GCP) and `EDGE_PROXY_SECRET`. Never put database/AI credentials in the Worker bundle or browser. Runtime secrets have not yet been installed in Google Secret Manager.

Missing/disabled AI now sends the web conversation to staff; it never silently presents the Demo responder as a production LLM. There is no LINE, Messenger, WhatsApp, OAuth callback or external webhook receiver in this repository.

## Deployment sequence

1. Connect the selected GCP project and verify billing, region, existing services and permissions. Agree any additional charges before deployment. Use a dedicated runtime service account with access only to the three application secrets. Prefer Workload Identity Federation for CI rather than a downloaded JSON key.
2. Build the non-root Node 24 container using `Dockerfile`. `deploy/cloudbuild.yaml` builds/pushes to an **existing verified** Artifact Registry image target; `deploy/cloudrun.service.example.yaml` is a review template, not a deployed service. Replace every placeholder and choose an approved image digest/secret version.
3. Deploy Cloud Run with the origin guard enabled. A public Cloud Run endpoint still requires the edge secret before the app serves any route; normal staff authentication is required inside the CRM/API. Direct origin requests must return 503. Do not disable the guard to make a readiness test pass.
4. Set the Worker upstream URL to the actual Cloud Run service URL, install the shared secret, then deploy with Cloudflare MCP. Record the actual workers.dev preview URL; set `APP_ORIGIN` to that exact preview origin.
5. Test preview login, API authorization, health, static assets, subpath refresh, SSE and failure recovery. Never run the Demo acceptance suite against production.
6. Only after preview passes, attach apex and www as Worker Custom Domains through Cloudflare. Let that API generate DNS/certificates; do not guess addresses or overwrite unrelated records.
7. Change `APP_ORIGIN` to the apex URL. The Worker sends www and HTTP-apex requests to HTTPS apex with a 308 redirect preserving path and query. Verify DNS, certificate, redirect, cookies, login and API over the real domain.

CRM/API responses use private/no-store and upstream fetches disable shared caching. Only public build assets/fonts retain cacheable response headers. Any later Cloudflare cache rules must preserve this policy.

Worker-specific HTTPS redirects do not change the zone-wide minimum TLS setting. Review SSL/TLS settings and their effect on other services before release.

## Cold starts and webhook reliability

Both Cloud Run at minimum zero and Neon Free can suspend when idle. The application uses a bounded pool (5 connections/instance), 10-second connection timeout, 15-second statement timeout and idle-connection error handling. It allows concurrent PostgreSQL requests instead of serializing the whole instance. These controls do not guarantee a webhook response deadline or eliminate outages.

Cloud Run minimum one can reduce application cold starts but incurs idle charges and does not prevent all restarts. Neon Free suspends after inactivity and cannot disable that behavior; always-active compute requires a paid plan. No paid option has been enabled and no end-to-end cold-start latency has been measured here.

For a future channel integration: verify the provider signature and size limit at ingress, durably enqueue, then acknowledge within the provider's deadline. Return a failure if enqueue fails. A separate authenticated consumer should deduplicate by provider event ID, process the database/AI work, retry transient failures with backoff, and route exhausted retries to a dead-letter queue with alerts. Do not acknowledge before durable enqueue or keep work only in process memory. Queue/provider credentials, signature rules and real channel integration are still to be implemented; web-chat idempotency tests are not webhook tests.

Official references:
- https://neon.com/docs/introduction/scale-to-zero
- https://docs.cloud.google.com/run/docs/configuring/min-instances
- https://docs.cloud.google.com/run/docs/configuring/billing-settings
- https://docs.cloud.google.com/run/docs/deploying-source-code

## Verification performed

- TypeScript and Next.js production standalone build passed.
- Production dependency audit reported zero advisories across 81 dependencies (including optional packages) at the time of inspection; this is not a guarantee against undisclosed vulnerabilities.
- 42 unit/provider/widget/migration/deployment tests passed.
- 33 HTTP acceptance tests passed on an isolated local Demo database, including username login, role/tenant checks, CSRF, logout, duplicate messages and widget origin rules.
- Standalone runtime smoke passed: direct-origin rejection, login/subpath refresh, real bundled JavaScript asset, and unconfigured-database readiness rejection.
- Cloudflare Worker dry-run bundle passed.
- Schema migrations were validated on an isolated PostgreSQL branch; application-role SQL privilege checks passed.
- Direct PostgreSQL access from this workspace failed DNS resolution (`EAI_AGAIN`). Production application login, pooled connection, cold/warm timing, Cloud Run container build, live domain and external webhook tests remain unverified.
- Focused security review covered the changed login, origin boundary, session/cookie handling, tenant checks, private caching and secrets. This is not a complete penetration test or a certification of production security.
