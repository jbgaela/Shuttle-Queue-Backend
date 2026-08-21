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

Use `npm run seed` once `BOOTSTRAP_USERNAME` and `BOOTSTRAP_PASSWORD` are set. `POST /api/v2/auth/login` establishes an opaque, httpOnly authentication session cookie; queue data is served from the account's automatically provisioned current workspace.

For the destructive legacy cutover, first verify a MongoDB backup, review `npm run migrate:remove-sessions -- --dry-run`, then apply only during the write-disabled maintenance window with `npm run migrate:remove-sessions -- --apply --backup-verified`.
