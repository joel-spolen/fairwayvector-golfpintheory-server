# Golf PinTheory data server

Standalone Node.js server for **shared, persistent read-through caching** of GolfAPI.io course data and GPXZ elevation profiles. Runs on a home Mac now; the same application and database can move to a hosted machine later.

**The iOS app is unchanged and does not use this server yet.** A later app change must route its GolfAPI and GPXZ clients here and authenticate to this server. Merely starting this server cannot redirect existing app requests.

## How it works

1. An authenticated client requests course data or an elevation profile.
2. The server looks in its SQLite database, shared across all callers.
3. A hit is returned without contacting the paid provider, even if paid fetching is disabled or the daily budget is exhausted.
4. A miss fetches once, validates the response, commits it to disk, then returns it. Simultaneous identical misses share one fetch.

Course search, details, coordinates and elevation responses survive restarts and **do not expire automatically**. One exception: timestamp-based course update probes are reusable for 24 hours, then rechecked on demand. Cache-only/disabled operation can still read older probes. No background prefetch, startup probes, automatic retries, user-triggered refresh bypass, or scheduled paid requests.

### Provider behavior copied from the app

- GolfAPI: `https://golfapi.io/api/v2.3`, GET requests with the server's `GOLF_API_KEY` as a bearer credential. Club searches use `country`, `state`, `name`, `page`; update searches also support `timestampUpdated`. Course/coordinate IDs are checked against the request. Numeric strings in GPS payloads are accepted. Provider account credits are stripped from shared responses.
- GPXZ: `https://api.gpxz.io/v1/elevation/sample`, POST with `x-api-key`, form-encoded `latlons`, integer `samples`, `interpolation=bilinear`, `bathymetry=false`. Default count matches the app: `min(512, max(2, ceil(pathLengthMeters) + 1))`. Checks include status, count, coordinate alignment, endpoints, finite elevation, positive resolution and source metadata. Dataset version is retained. GPXZ's datum is EGM2008; distances/elevations are metres.
- Provider redirects are rejected; timeout is 30 seconds; responses are bounded to 4 MB. Provider error bodies and credentials are never reflected or logged.

**Elevation cache scope:** exact normalized paths and sample counts, globally shared—not per user or course. Duplicate consecutive points are removed, but GPS coordinates are not rounded. Different GPS origins, reversed lines, changed sample counts, and overlapping/subsection paths remain different requests and can incur additional charges. This server does not port the app's geometric partial-coverage stitching algorithm or download entire courses' terrain. It does not infer an unsampled line from two saved endpoints. This conservative policy avoids presenting nearby or interpolated data as an identical provider response.

## Requirements and first start

- Node.js **22.19 or newer** (tested with 22.19.0), npm. Built-in SQLite avoids a separate database service. Node 22 prints an experimental SQLite warning; this is expected.
- No Docker, Python or Xcode required. Course caching works without Supabase; optional account/storage monitoring uses your Supabase project.

From this directory:

1. Install dependencies with `npm ci`.
2. Copy `.env.example` to `.env`. Keep `.env` local and private.
3. Set `SERVER_API_TOKEN` to a random secret of at least 32 characters, generated with a password manager. This is a **server client credential**, not either provider key.
4. Add `GOLF_API_KEY` and `GPXZ_API_KEY` locally. Obtain them from the providers; no credentials were copied out of the app.
5. Leave both `*_ENABLED=false` until ready to incur charges. Set the desired provider to `true` to allow cache misses to fetch. Re-start after configuration changes.
6. Review UTC daily limits before enabling providers. Defaults are 100 attempted requests per provider per day. Set a limit to `0` to prevent misses for that provider.
7. Start with `npm start`. It listens on `127.0.0.1:8080` by default. Stop with Ctrl-C; shutdown waits for in-flight acquisitions to finish persisting.

`GET http://127.0.0.1:8080/healthz` returns `{"status":"ok"}` without authentication or a provider call. All data endpoints require `Authorization: Bearer <SERVER_API_TOKEN>`. Use an API client to exercise them. **Data-endpoint smoke tests with enabled providers may cost money.**

`npm test` runs offline regression tests with injected fake providers and temporary databases. `npm run check` checks syntax. Tests do not use local provider keys or `.env` and never call paid services.

## Admin dashboard

Open **http://127.0.0.1:8080/admin** after starting the server. Set `ADMIN_API_TOKEN` in your private `.env` to a random 32–512 character secret **different from `SERVER_API_TOKEN`**, restart, and enter that admin token on the page. Leaving it blank disables admin data access. No credential was generated or saved by this feature. The public login shell contains no private data; all admin API endpoints require the separate admin credential. It cannot be used on the client data API, and the client token cannot access administration.

The responsive dashboard includes:

- **Course inventory:** searchable, paginated courses with cached detail/GPS status, coordinate counts, hole counts and original fetch dates. A course appearing only in search results is not shown as downloaded. Elevation-tagged courses can appear before details/GPS are cached, clearly marked as missing those payloads.
- **Elevation by course:** number of linked profiles, sample count, stored JSON size and total path length. Global totals count each cached profile once; a shared profile linked to multiple courses contributes to each course's inventory. Profile overlap and repeated sample locations are not deduplicated spatially. These are data-volume measures, **not percentage of course terrain covered**.
- **Traffic:** authenticated client data requests, completed responses, stored-cache hit rate, successful MISS responses, coalesced responses and errors. Today, last 7/30 days and all-time selectors filter traffic; inventory always describes the entire cache. Daily charts use UTC. Auto-refresh is optional, every 30 seconds.
- **Provider calls:** authoritative persisted attempt counts from the spending ledger, split by GolfAPI and GPXZ, with today's budget, enabled status and cooldown. Failed calls count too. Comparing requests/hits/coalescing with provider attempts shows how much work reaches paid services without claiming an exact monetary saving.
- **Unassigned profiles:** inspect the latest 50 unlinked profiles and associate them with a known cached course. This only writes local metadata; viewing or refreshing the dashboard and assigning profiles **never fetch paid data**. Course choices are capped at the first 1,000 sorted courses.

### Associating elevation with a course

Elevation requests accept an optional JSON/form `courseID` string containing the exact GolfAPI course ID. The tag is validated but is client-supplied context, not proof of geographic ownership. It is stored only after successful cache access and is **excluded from the provider request and cache key**. The same exact path/sample count therefore remains one globally shared cached response across users and course tags. A cache hit with a tag can also associate older data without another provider call. No iOS changes were made; future client integration should supply this field.

Existing profiles have no reliable course identity, so migration deliberately leaves them **unassigned** rather than inferring ownership from proximity. Original-path lengths become available on subsequent normal cache access. Until then, legacy length is estimated from consecutive returned sample locations and shown with `≈`; a curved original path may be longer. The admin association control does not make that estimate exact. Associations are additive/idempotent; there is no deletion, reassignment, or cache-purge UI.

### Counter definitions and privacy

Counters start when this version first opens the database and survive restarts; the dashboard displays that tracking start. **Historical client traffic cannot be reconstructed.** Older provider-attempt history is retained, so upstream totals can predate client counters. Received requests and completions use their own UTC event day, which may differ across midnight. A request still running or disconnected may have no completed response; successful MISS responses are not an upstream-success counter. Stored-cache hit rate is HIT completions divided by all completed client requests, including errors; coalesced responses are shown separately.

Health checks, admin requests, unknown routes, authentication failures and requests rejected by the pre-authentication rate limiter are not client traffic. Authenticated known data routes that fail input validation, budget, cooldown or cache-only checks count as errors. There is no unique-user count: the server still uses a shared client token. Only aggregate daily provider counters are stored, not IPs, identities, request query strings or individual GPS request logs.

The token is held only in page memory—no cookie, browser storage or token-bearing URL—and is cleared on logout/authorization failure. Reloading requires login again. Use HTTPS/VPN for remote access and keep the admin credential private. Admin refreshes share the server's existing direct-IP rate limit. Admin inspection scans/aggregates the local cache, so very large inventories may require future indexing/performance work.

Admin API: `GET /api/admin/overview?days=7&search=&page=1` and `POST /api/admin/elevation/assign` with JSON `{ "key": "gpxz:sample:v1:<64-character digest>", "courseID": "<cached ID>" }`. They never call providers. Schema migration is additive and keeps existing response bodies, spending counters and cooldowns; ordinary SQLite backups include the new metadata/counters.

### Supabase users & storage (optional)

The **Users & storage** section reads a server-only aggregate Supabase RPC through `GET /api/admin/accounts`. No user list, email, password, UUID, provider key or Supabase service credential is returned to the browser. This does **not** implement individual-user authentication for the course API; its existing shared client token is unchanged.

Setup requires operator action:

1. Review the new sibling backend migration `backend/migrations/202610240001_admin_account_metrics.sql`, after all three existing backend migrations. Test it and `backend/tests/admin_account_metrics_regression.sql` in a **disposable staging Supabase project** first. These SQL files have **not been database-executed or deployed** by this implementation. Do not assume they are already installed. The migration adds a private aggregate counter and Auth lifecycle trigger, with a temporary Auth write lock during installation; rehearse signup and deletion behavior before production approval.
2. After approved deployment, set `SUPABASE_URL` to the project's HTTPS root URL and `SUPABASE_SERVICE_ROLE_KEY` to its **server-only** privileged key in the local `.env`, then restart. Leave both blank to disable this optional integration. Supply both or neither. A publishable/anon key is insufficient. Do not paste privileged keys into chat, browser inputs, SQL source, the app, or git. Legacy service-role JWTs use `apikey` plus bearer headers; newer `sb_secret_` keys use `apikey` only and depend on the project's gateway support.
3. Log into `/admin` with the separate **admin token**, not the Supabase key. Refresh loads aggregate metrics. Successful remote snapshots are reused for 60 seconds; failures are reused for 15 seconds, and any prior snapshot is explicitly marked stale. Upstream timeout is 10 seconds, browser deadline 15 seconds. A missing migration, denied permission or outage shows **Unavailable**, never fake zero users. Course/cache monitoring still works.

Metric definitions:

- **Current accounts:** non-anonymous Auth rows not soft-deleted. Includes unconfirmed or banned accounts; these are account counts, not unique people.
- **Signed in last 30 days:** current accounts whose Auth `last_sign_in_at` is within 30 days. This is an explicit **sign-in recency proxy**, not actual app activity/online presence/monthly active users. Token refresh and offline app use are not measured. Accurate app activity needs future authenticated usage/heartbeat instrumentation.
- **Known registrations:** current baseline registrations plus observed registrations after tracking starts, retained as aggregate numbers even after deletion. Physically deleted accounts from before installation are unknowable from current Auth rows, so the UI shows a **lower bound** with `+`, not an exact all-time total. Soft deletion followed by hard deletion counts once. Anonymous accounts are excluded; anonymous-to-registered conversion counts as registration. Re-registration counts as another account, not another unique human.
- **Current-user logical sync:** aggregate PostgreSQL JSONB column sizes for records (including tombstones), history events and mutation receipts belonging to current registered accounts. Average includes zero-byte accounts; maximum is the largest per-account logical total. Compression/row/index effects mean these are **payload-size estimates**, not billed capacity or a full disk allocation per user. Unsynced device-only data and shared course/elevation cache are not counted here.
- **Physical sync tables:** all four sync relations including indexes/TOAST and all retained rows. **Whole project database** is broader still, including Auth and other schemas. These are separate operational sizes; never add logical bytes to physical bytes. **Object storage** is explicitly unknown, not zero; this implementation does not measure Supabase Storage bucket contents, backups, WAL, quotas or future capacity requirements. Use the Supabase billing/usage dashboard for plan capacity and object storage, and growth history before forecasting needed storage.

No Supabase requests occur at server startup or from the ordinary overview/data routes. Only an authenticated accounts request invokes the fixed RPC; no background polls, signup calls or paid golf/elevation calls are made. Counts are not filtered by the traffic-period selector. Metrics are held in server memory briefly, not copied into the course cache. The SQL lifecycle counters contain no user identity history. Privileged service credentials have broad power: secure the home machine, use HTTPS for remote admin access and rotate keys if exposed.

## API contract

Base path: `/api/v1`. Success responses retain provider-compatible JSON shapes, except the account-level GolfAPI `apiRequestsLeft` field is removed. Errors are `{"error":{"code":"...","message":"..."}}`.

| Method | Endpoint                                                                     | Purpose                                                      |
| ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| GET    | `/healthz`                                                                   | Public process health only; no paid-provider readiness probe |
| GET    | `/api/v1/golf/clubs?country=Sweden&name=Hills&page=1`                        | Club/course discovery                                        |
| GET    | `/api/v1/golf/courses?country=Sweden&name=Hills&timestampUpdated=...&page=1` | Course search/update probe                                   |
| GET    | `/api/v1/golf/courses/{id}`                                                  | Course details, tees and ratings                             |
| GET    | `/api/v1/golf/coordinates/{id}`                                              | Course GPS geometry                                          |
| POST   | `/api/v1/elevation/sample`                                                   | Elevation along a path                                       |

Search requires `country`, `state` or `name`. `page` defaults to 1; pages are cached independently and are not silently aggregated. Strings are trimmed and Unicode-normalized; case and exact IDs remain significant. IDs allow letters, digits, `_` and `-`, up to 100 characters. Unknown query/body fields, including `refresh`, are rejected. No arbitrary upstream URL is accepted.

Elevation accepts `application/json`, for example:

```json
{
  "path": [
    { "lat": 57.623, "lon": 12.0 },
    { "lat": 57.624, "lon": 12.002 }
  ],
  "samples": 128
}
```

Alternatively send JSON `latlons: "57.623,12|57.624,12.002"`, or the app-compatible `application/x-www-form-urlencoded` body with `latlons`, `samples`, `interpolation=bilinear`, `bathymetry=false`. Do not send both `path` and `latlons`. Samples are optional, 2–512; paths require 2–5000 points, valid coordinates and nonzero total length up to 20 km.

Useful headers:

- Request `X-Cache-Only: true`: return only saved data, never fetch, reserve budget or join a paid acquisition. A miss returns 404 `cache_miss`. Useful for the app's eventual cache-only open/GPS flows.
- Response `X-Cache`: `HIT`, `MISS` or `COALESCED`.
- Response `X-Fetched-At`: original fetch timestamp, unchanged on hits.
- Response `X-Dataset-Version`: GPXZ version when provided.
- Response `Retry-After`: cooldown/busy delay where applicable.

HTTP 401 means missing/incorrect server token; 400 invalid input (very long path parameters can return 414); 404 cache-only miss; 429 local request rate limit; 502 upstream error/invalid data; 503 disabled fetching, daily budget, cooldown or concurrency limit. No provider error response is saved as successful data.

## Spending and security controls

- Every dispatched provider attempt reserves a durable UTC daily budget **before dispatch**. Failures/timeouts consume budget; there is no automatic refund. These are request counts, not monetary or provider-credit estimates. GolfAPI's billing weights may differ. Check provider dashboards and quotas too.
- Identical concurrent misses are coalesced. Unrelated misses exceeding the global concurrency limit return 503 rather than building an unbounded queue.
- Failures lock that request for at least five minutes. Throttling/authentication/server/transport failures also pause that provider; resource-specific HTTP errors and validation failures do not block unrelated keys. `Retry-After` is honored up to 24 hours. Cooldowns survive restart.
- Rate limiting uses the direct connection IP; forwarded headers are deliberately **not trusted**. Behind a reverse proxy/tunnel all clients may share a local limit. Adjust the configured limit conservatively or implement trusted proxy rules before wider use.
- One server process per data directory; an exclusive lock prevents a second process from bypassing in-memory coalescing. After an unclean kill, manually remove `data/server.lock` **only after verifying no server using it is still running**. A stale lock intentionally fails closed.
- Logs do not contain request URLs, GPS bodies, auth headers or provider errors. Keep data/backups private: they contain requested locations and provider-licensed content.
- Authentication currently uses one shared bearer token, suitable for controlled home testing. **Do not ship this shared secret inside a public iOS app.** Before public launch, add verified per-user sessions (for example existing Supabase Auth JWTs), per-user limits, monitoring and abuse controls; keep provider keys only on the server.

## Home-computer deployment

### Same Mac / private LAN

Local default is safest. For trusted LAN testing, set `HOST=0.0.0.0`, restart and use the Mac's private LAN address plus port 8080. Allow incoming traffic in the macOS firewall only as needed. HTTP exposes bearer tokens on the network: use this only for trusted development, preferably behind a private VPN and HTTPS. Do not add a router port-forward for 8080.

### Outside your home

Recommended temporary setup: a private VPN (e.g. Tailscale) or a **named HTTPS tunnel/reverse proxy** to `127.0.0.1:8080`. Keep the listener local, retain token authentication, use a stable HTTPS hostname, and configure tunnel access rules. A tunnel/VPN client must be installed/configured separately; nothing has been exposed publicly by this setup. TLS certificates, DNS, router rules and tunnel credentials are intentionally not generated here. Future iOS integration should use HTTPS; no app transport-security changes were made.

Keep the Mac powered and awake; a sleeping home computer cannot serve users. `caffeinate` can keep it awake during deliberate testing. Home internet outages or restarting the Mac make the API unavailable. This is not a highly available production deployment.

### Start automatically on macOS (optional)

An example LaunchAgent is included in `deploy/com.fairwayvector.golfpintheory-server.plist.example`. Copy it to your user's LaunchAgents directory as a `.plist`, replace `PROJECT_DIRECTORY` and `NODE_EXECUTABLE` with absolute paths, and create the project's ignored `logs` directory first. The configured Node must be 22.19+; LaunchAgents do not inherit a terminal's version-manager setup. It loads the project's private `.env`; no keys belong in the plist. Use macOS `launchctl` to load/start it after editing, and stop any manually started server first. The agent runs after user login, not before. It intentionally does not restart continuously after an error: inspect logs/configuration or a stale lock before restarting. No launch service was installed automatically.

## Database, backups and moving to hosting

The default directory is `data`; `DATA_DIR` can be an absolute path to persistent local storage. It contains `cache.sqlite`, its SQLite WAL/SHM companions while running, and the process lock. There is no eviction or disk quota yet: monitor free disk space and database growth. Do not place an active SQLite database on a network/cloud-sync folder.

Run `npm run backup` for a timestamped snapshot under ignored `backups`, or `npm run backup -- /absolute/destination.sqlite`. This uses SQLite's online backup so committed WAL data is included. Protect/encrypt backups and periodically test restoration. A backup contains responses, spending counters and cooldowns, but not provider keys.

To restore/migrate: stop the server, back up current data, place the snapshot at the destination data directory's `cache.sqlite`, and start using the same Node version and configuration. Never leave old `-wal`/`-shm` companions alongside a replacement database; use a clean stopped destination directory and preserve the original directory for recovery. Do not copy a running main database file alone. Migrating provider keys is a separate secure operation. If you delete the database or restore an old backup, counters and cached coverage go backwards and duplicate paid requests become possible—reconcile daily limits before re-enabling providers.

This project does not import private app caches, bundle real paid-course exports, migrate account data, serve weather/imagery/Overpass, or modify the existing iOS/Supabase projects. Confirm both providers' storage, shared-cache, redistribution and attribution terms under your subscription before exposing this service to users.
