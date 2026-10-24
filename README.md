# PinTheory local admin GUI

This project is **only a local dashboard and thin privileged Supabase bridge**.
It serves no course/elevation client API, performs no paid acquisition, opens no
SQLite database and creates no data directory or lock. The iOS app is unchanged.
Hosted clients and providers belong in the canonical sibling
**fairwayvector-golfpintheory-supabase** repository, not this server.

## Start locally

Requires Node.js 22.19+ and npm. Install with `npm ci`, copy the example environment
to a private local environment file, then use `npm start`. Open
http://127.0.0.1:8080/admin (or the printed IPv6 address if configured).
The dashboard loads automatically: **no password, client token, admin token,
signup or logout**. `npm run dev` watches source changes.

Only four settings are used:

| Setting                   | Meaning                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| HOST                      | `127.0.0.1` (default) or `::1` only; every other value is rejected |
| PORT                      | 8080 by default; 0 selects an ephemeral port for tests             |
| SUPABASE_URL              | Trusted HTTPS project root with a DNS hostname                     |
| SUPABASE_SERVICE_ROLE_KEY | Server-only privileged service key                                 |

Supabase settings are optional **together**. Both unset starts normally with an
available shell, overview HTTP 503 setup message and disabled account metrics.
Partial/invalid configuration fails with a value-free error. The existing strict
HTTPS root/key validator is retained; anon/publishable keys are not accepted.
Legacy JWTs use apikey plus bearer headers; `sb_secret_` keys use apikey only.
No credential or remote project URL is returned to the browser.

Deprecated SERVER_API_TOKEN, ADMIN_API_TOKEN, DATA_DIR, paid-provider keys,
provider enable/budget/concurrency settings and rate-limit settings in an old
local environment are **ignored**, not required. This conversion does not edit
or delete private environments, existing data, SQLite/WAL files or backups.
Legacy backup/export/import operations are not part of this running GUI; retain
original databases and consistent snapshots for a separately reviewed migration.
Never copy only the main file of a live SQLite database.

## Local security boundary

The operator's OS account is the trust boundary. Any local process can use this
service; the GUI is not protection against malware or untrusted local users.
Service keys remain privileged: protect the machine and local environment.

- Binds only to literal loopback. Socket peers must be loopback, regardless of
  forwarded headers. Proxy headers are not trusted.
- Host must be exactly the configured loopback literal or `localhost`, including
  the actual listening port. IPv6 requires brackets. Other loopback aliases,
  hostnames, port substitutions, trailing dots and duplicate Hosts are rejected.
- If Origin is present, it must exactly equal `http://` plus the validated Host.
  Cross-site Fetch Metadata requests are rejected, including GET requests.
- Every mutating request requires `X-Local-Admin: 1`; the dashboard adds it to
  JSON POSTs. There is no permissive CORS/preflight handler.
- Static paths are allowlisted, with same-origin CSP, no framing, no external
  scripts/fonts, no browser credentials/storage and no request logging.
- Remote errors, exception messages, credentials and response bodies are never
  reflected. API errors have fixed messages. No outbound startup calls.

**Do not expose through a tunnel, reverse proxy, LAN bind or router forwarding.**
Do not rewrite Host or bypass these checks for remote access. A sleeping/stopped
Mac only stops this dashboard; separately deployed hosted data service operation
does not depend on it.

## Fixed admin endpoints

| Local endpoint                                | Remote service RPC                                       |
| --------------------------------------------- | -------------------------------------------------------- |
| GET /api/admin/overview?days=7&search=&page=1 | pintheory_data_admin_overview `{p_days,p_search,p_page}` |
| POST /api/admin/elevation/assign              | pintheory_data_admin_assign `{p_key,p_course_id}`        |
| GET /api/admin/accounts                       | pintheory_admin_account_metrics `{}`                     |
| GET /healthz                                  | Process health only, no remote request                   |

Overview accepts days 0/1/7/30, search up to 200 characters and positive pages.
Assignments accept JSON key (gpxz sample digest) and courseID; they associate
existing stored data only. No creation, acquisition or provider fallback exists.
All former /api/v1 client routes return 404.

Overview is reconstructed from an explicit nested allowlist: aggregate traffic,
provider enabled/dailyLimit/cooldown status, paginated course inventory, bounded
profile metadata/endpoints and course choices. Raw provider payloads are not
passed through. The RPC transport allows only those fixed data-admin RPCs,
rejects redirects, caps streamed responses at 4 MiB and times out the **entire**
fetch/read operation after 15 seconds without retries. Invalid contracts fail
closed. No shared-data snapshot is persisted locally.

Accounts retain their independent aggregate-only in-memory cache: 60 seconds on
success, 15 seconds on failure, 10-second full-operation deadline and 256 KiB
response cap. Previous data is explicitly stale after failure. Missing/outage
metrics are unknown, never zero. Overview outages do not disable account loading.
The dashboard retains last successful overview data with stale labels and pauses
associations until a successful refresh. Auto-refresh is optional every 30 seconds.

Course/elevation inventory is global, not per user. Profile path lengths and sample
counts are not surveyed area or spatial coverage. Shared profiles count once in
global totals but can contribute to multiple course summaries. Traffic counts
UTC database events, not confirmed HTTP deliveries: terminal outcomes are cache
hits, persisted fetches and recorded errors. PENDING waiters are not served
coalesced responses, and retrying is another request. Provider attempts include
reserved/uncertain dispatches, not successful-request counts or currency.
Cloud tracking starts independently; old SQLite traffic is not silently imported.

Users & storage are separate from shared-cache data: signed-in-last-30-days is a
sign-in recency proxy, not MAU; known registrations are a lower bound if earlier
hard deletions are unknown. Logical current-user JSONB bytes are not billing or
physical disk allocation. Physical sync/database sizes are different scopes;
object storage is unknown. No individual user records are exposed.

## Supabase staging setup (operator action)

1. Use **fairwayvector-golfpintheory-supabase** as the canonical source for hosted
   migrations/functions/tests. Review that repository's current README and RPC
   contract rather than copying obsolete SQL from the iOS project.
2. Apply its reviewed migration sequence to a **disposable staging project**.
   Verify service-only ACL/RLS/role guards for all three RPCs above; anon and
   authenticated clients must not invoke privileged administration. Verify the
   overview contract and assignment idempotency with synthetic stored data.
3. Run the sibling repository's SQL, concurrency and Edge offline tests. Test
   account signup/deletion counters and unavailable/stale behavior. Keep provider
   acquisition disabled. No deployment or real-provider request is performed by
   this GUI or its tests.
4. Enter staging URL and service key directly in the operator's private local
   environment, never chat/browser/source, then restart. Refresh exercises only
   the fixed aggregate RPCs. An unavailable message may mean missing migrations,
   permissions, connection failure or malformed response; details stay private.
5. Production migration/deployment, credentials and any SQLite import/export
   require separate operator review/approval. This server does not perform them.

## Verification and optional launch

`npm run check`, `npm test` and `npm audit` validate syntax, offline injected
transport/security regressions and dependencies. Tests do not load the private
environment or contact real Supabase/providers. No database is needed.

The example macOS LaunchAgent under deploy can retain its existing service label.
Replace its project/Node placeholders with absolute local paths, create its
ignored logs directory and load it manually only if desired. It runs this local
GUI after user login; credentials must never be placed in the plist. No launch
service, tunnel, deployment or background server is installed by this conversion.
