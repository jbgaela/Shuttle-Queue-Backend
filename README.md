# Shuttle Queue API

Express 5 + Prisma MongoDB API for Queue Masters. The database schema lives in `prisma/schema.prisma`; Prisma Client is generated during deployment.

```powershell
Copy-Item .env.example .env
npm install
npm run prisma:generate
npm run prisma:validate
npm run prisma:push
npm run dev
```

Render runs `prisma:push` as the pre-deploy step so additive schema changes, including public ranking publications, are applied before the new service starts.

## Ranking link tracking rollout

Public ranking traffic is forwarded by the frontend Netlify Edge Function. Set the same random, server-only `PUBLIC_RANKING_EDGE_SECRET` (at least 32 characters) on Netlify and Render. Production public-ranking requests without a valid signature are rejected. Development requests use the socket IP with no approximate location.

The additive `PublicRankingLink` and `PublicRankingVisit` collections preserve separate issued-link histories. After reviewing `prisma:push`, run `npm run setup:ranking-tracking` with `DATABASE_URL` configured. Render runs this idempotent setup after schema synchronization: it backfills the tokens still present in publications and installs the MongoDB `PublicRankingVisit_expiresAt_ttl` index. Backfill cannot recover overwritten tokens or past visits. TTL deletes expired documents asynchronously; the API immediately excludes visits older than 90 days. Verify the TTL index and eventual deletion in a staging MongoDB replica set before activation.

Deploy in a coordinated window: prepare the signing secret and database, deploy the frontend edge proxy/location gate and backend, smoke-test the Netlify-to-Render path, then set `PUBLIC_RANKING_LOCATION_REQUIRED=true` on Render. Its initial `false` value is only for compatible rollout and does **not** enforce location at the API. The public frontend always requires a saved location. Private tracking requires a signed-in owner or Super Admin. Approved browser-location visits expire after 12 hours; raw visit keys are never stored. Location reports and user agents are unverified client reports.

For rollback after activation, first set `PUBLIC_RANKING_ACCESS_ENABLED=false` to block all public ranking API routes, restore compatible deployments, and re-enable only after verification. Keep the additive collections and TTL index; do not drop tracking data as an application rollback. Existing account deletion also removes that account's links and visits.

Verify real IPv4/IPv6 observations, permission failure paths, revocation, owner/admin isolation, retention, and signed metadata on a preview deployment. Monitor aggregate `ranking_visit_write_failed`, `ranking_location_write_failed`, `ranking_tracking_request_failed`, and HTTP 429 rates. The application limiters are per process; this feature is not a distributed DDoS defense. No production load testing is required.

Use `npm run seed` once `BOOTSTRAP_USERNAME` and `BOOTSTRAP_PASSWORD` are set. `POST /api/v2/auth/login` establishes an opaque, httpOnly authentication session cookie; queue data is served from the account's automatically provisioned current workspace.

For the destructive legacy cutover, first verify a MongoDB backup, review `npm run migrate:remove-sessions -- --dry-run`, then apply only during the write-disabled maintenance window with `npm run migrate:remove-sessions -- --apply --backup-verified`.
