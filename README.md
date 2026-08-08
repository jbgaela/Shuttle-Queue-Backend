# Shuttle Queue API

Express 5 + Prisma MongoDB API for Queue Masters. The database schema lives in `prisma/schema.prisma`; Prisma Client is generated during deployment.

```powershell
Copy-Item .env.example .env
npm install
npm run prisma:generate
npm run prisma:validate
npm run dev
```

Use `npm run seed` once `BOOTSTRAP_USERNAME` and `BOOTSTRAP_PASSWORD` are set. `POST /api/v1/auth/login` establishes an opaque, httpOnly session cookie.
