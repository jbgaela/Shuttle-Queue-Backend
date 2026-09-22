import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import express, { type RequestHandler } from "express";
import { Prisma } from "@prisma/client";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "mongodb://127.0.0.1:27017/ranking-tracking-test";
process.env.SESSION_SECRET_PEPPER = "test-only-session-pepper";
process.env.SUGGESTION_SIGNING_SECRET = "test-only-signing-secret";
process.env.PUBLIC_RANKING_LOCATION_REQUIRED = "true";
const { createRankingTrackingRouter, assertRankingLocation } = await import("../../src/lib/ranking-tracking-routes.js");
const { trackingHash } = await import("../../src/lib/ranking-tracking.js");
const { publicRankingBody, publicRankingEdge } = await import("../../src/lib/ranking-tracking-http.js");

function fixture() {
  const publication: any = { id: randomUUID(), queueMasterId: "owner", publicToken: randomUUID(), enabled: true, revokedAt: null, publishedAt: new Date(), sessionStartedAt: new Date(), finalizedAt: null };
  const link: any = { id: randomUUID(), queueMasterId: "owner", publicationId: publication.id, tokenHash: trackingHash(publication.publicToken), issuedAt: publication.publishedAt, revokedAt: null, publication };
  const visits = new Map<string, any>();
  let writeFailure = false;
  let lastVisitQuery: any;
  const matches = (visit: any, where: any) => Boolean(visit && (!where.id || visit.id === where.id) && (!where.linkId || visit.linkId === where.linkId) && (!where.expiresAt || visit.expiresAt > where.expiresAt.gt) && (!where.link || (where.link.publicationId === publication.id && where.link.tokenHash === link.tokenHash)));
  const database: any = {
    publicRankingPublication: { findFirst: async ({ where }: any) => publication.enabled && !publication.revokedAt && where.publicToken === publication.publicToken ? publication : null },
    publicRankingLink: {
      upsert: async () => link,
      findFirst: async ({ where }: any) => where.id === link.id && (!where.queueMasterId || where.queueMasterId === "owner") ? link : null,
      findMany: async ({ where }: any) => where.queueMasterId === "owner" ? [link] : [],
    },
    publicRankingVisit: {
      create: async ({ data }: any) => {
        if (writeFailure) throw new Error("test write failure");
        if (visits.has(data.visitKeyHash)) throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "6" });
        const visit = { ...data, id: randomUUID(), locationStatus: "PENDING", accessExpiresAt: null, latitude: null, longitude: null, accuracy: null };
        visits.set(data.visitKeyHash, visit); return visit;
      },
      findUnique: async ({ where }: any) => visits.get(where.visitKeyHash) ?? null,
      findUniqueOrThrow: async ({ where }: any) => [...visits.values()].find((visit) => visit.id === where.id),
      findFirst: async ({ where }: any) => { const visit = visits.get(where.visitKeyHash); return matches(visit, where) ? visit : null; },
      updateMany: async ({ where, data }: any) => {
        if (writeFailure) throw new Error("test write failure");
        const visit = visits.get(where.visitKeyHash);
        if (!matches(visit, where) || (visit.locationStatus === "GRANTED" && visit.accessExpiresAt > new Date())) return { count: 0 };
        Object.assign(visit, data); return { count: 1 };
      },
      findMany: async (query: any) => { lastVisitQuery = query; return [...visits.values()].filter((visit) => matches(visit, query.where) && (!query.where.locationStatus || visit.locationStatus === query.where.locationStatus)).map(({ visitKeyHash: _secret, ...visit }) => visit); },
    },
  };
  const auth: RequestHandler = (request: any, response, next) => {
    const account = request.get("x-test-account");
    if (!account) { response.status(401).json({ error: { code: "AUTH_REQUIRED" } }); return; }
    request.auth = { queueMaster: { id: account, role: account === "admin" ? "SUPER_ADMIN" : "QUEUE_MASTER" } }; next();
  };
  const admin: RequestHandler = (request: any, response, next) => { if (request.auth.queueMaster.role !== "SUPER_ADMIN") response.status(403).json({ error: { code: "FORBIDDEN" } }); else next(); };
  const app = express();
  app.use("/api/v2/public/rankings", publicRankingBody, publicRankingEdge);
  app.use(express.json());
  app.use("/api/v2", createRankingTrackingRouter(database, auth, admin));
  app.get("/api/v2/public/rankings/:token", async (request, response, next) => {
    try {
      if (!publication.enabled || request.params.token !== publication.publicToken) { response.status(404).end(); return; }
      await assertRankingLocation(request, publication.id, database); response.json({ data: { rankings: [] } });
    } catch (error) { next(error); }
  });
  app.use((error: any, _request: any, response: any, _next: any) => response.status(error.status ?? 500).json({ error: { code: error.code, message: error.message } }));
  return { app, publication, link, visits, failWrites: () => { writeFailure = true; }, query: () => lastVisitQuery };
}

async function runFixture(context: any) {
  const state = fixture();
  const server = state.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  context.after(() => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address() as { port: number };
  const request = (path: string, method = "GET", key?: string, body?: unknown, account?: string) => fetch(`http://127.0.0.1:${address.port}/api/v2${path}`, { method, headers: { "content-type": "application/json", ...(key ? { "x-ranking-visit-key": key } : {}), ...(account ? { "x-test-account": account } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { ...state, request, path: `/public/rankings/${state.publication.publicToken}` };
}

test("concurrent retries are idempotent; separate page openings remain separate", async (t) => {
  const f = await runFixture(t); const key = randomBytes(32).toString("hex");
  const responses = await Promise.all(Array.from({ length: 5 }, () => f.request(`${f.path}/visits`, "POST", key, {})));
  assert.deepEqual(responses.map((response) => response.status), [201, 201, 201, 201, 201]);
  assert.equal(f.visits.size, 1);
  await f.request(`${f.path}/visits`, "POST", randomBytes(32).toString("hex"), {});
  assert.equal(f.visits.size, 2);
  assert.equal([...f.visits.values()][0].ipAddress, "127.0.0.1");
});

test("denial blocks reads, granted location unlocks, duplicate denial cannot downgrade", async (t) => {
  const f = await runFixture(t); const key = randomBytes(32).toString("hex");
  await f.request(`${f.path}/visits`, "POST", key, {});
  assert.equal((await f.request(f.path, "GET", key)).status, 403);
  await f.request(`${f.path}/visits/location`, "PATCH", key, { status: "DENIED" });
  assert.equal((await f.request(f.path, "GET", key)).status, 403);
  await f.request(`${f.path}/visits/location`, "PATCH", key, { status: "GRANTED", latitude: 14.6, longitude: 121, accuracy: 10 });
  assert.equal((await f.request(f.path, "GET", key)).status, 200);
  const denied = await f.request(`${f.path}/visits/location`, "PATCH", key, { status: "DENIED" });
  assert.equal((await denied.json()).data.status, "GRANTED");
  assert.equal(f.visits.size, 1);
  [...f.visits.values()][0].accessExpiresAt = new Date(0);
  assert.equal((await f.request(f.path, "GET", key)).status, 403);
});

test("invalid coordinates, missing visit and cross-link keys cannot grant access", async (t) => {
  const f = await runFixture(t); const key = randomBytes(32).toString("hex");
  assert.equal((await f.request(`${f.path}/visits/location`, "PATCH", key, { status: "GRANTED", latitude: 0, longitude: 0, accuracy: 0 })).status, 404);
  await f.request(`${f.path}/visits`, "POST", key, {});
  assert.equal((await f.request(`${f.path}/visits/location`, "PATCH", key, { status: "GRANTED", latitude: 91, longitude: 0, accuracy: 0 })).status, 422);
  f.link.tokenHash = trackingHash(randomUUID());
  assert.equal((await f.request(f.path, "GET", key)).status, 403);
});

test("revocation blocks submissions and reads while retaining private history", async (t) => {
  const f = await runFixture(t); const key = randomBytes(32).toString("hex");
  await f.request(`${f.path}/visits`, "POST", key, {});
  f.publication.enabled = false;
  assert.equal((await f.request(`${f.path}/visits`, "POST", key, {})).status, 404);
  assert.equal((await f.request(`${f.path}/visits/location`, "PATCH", key, { status: "DENIED" })).status, 404);
  assert.equal((await f.request(f.path, "GET", key)).status, 404);
  assert.equal(f.visits.size, 1);
  const response = await f.request(`/workspace/public-rankings/tracking-links/${f.link.id}/visits`, "GET", undefined, undefined, "owner");
  assert.equal(response.status, 200);
});

test("private history enforces owner/admin access and excludes expired visits and keys", async (t) => {
  const f = await runFixture(t); const key = randomBytes(32).toString("hex");
  await f.request(`${f.path}/visits`, "POST", key, {});
  const url = `/workspace/public-rankings/tracking-links/${f.link.id}/visits`;
  assert.equal((await f.request(url)).status, 401);
  assert.equal((await f.request(url, "GET", undefined, undefined, "other")).status, 404);
  const admin = await f.request(url, "GET", undefined, undefined, "admin");
  assert.equal(admin.status, 200);
  const body = await admin.json(); assert.equal(body.data.items.length, 1); assert.equal(JSON.stringify(body).includes(key), false); assert.equal(body.data.items[0].visitKeyHash, undefined);
  assert.equal(f.query().take, 51); assert.deepEqual(f.query().orderBy, [{ openedAt: "desc" }, { id: "desc" }]);
  [...f.visits.values()][0].expiresAt = new Date(0);
  assert.equal((await (await f.request(url, "GET", undefined, undefined, "owner")).json()).data.items.length, 0);
  assert.equal((await f.request("/admin/accounts/owner/public-ranking-links", "GET", undefined, undefined, "owner")).status, 403);
  assert.equal((await f.request("/admin/accounts/owner/public-ranking-links", "GET", undefined, undefined, "admin")).status, 200);
});

test("database write failure remains retryable and cannot grant access", async (t) => {
  const f = await runFixture(t); const key = randomBytes(32).toString("hex"); f.failWrites();
  const response = await f.request(`${f.path}/visits`, "POST", key, {});
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "TRACKING_UNAVAILABLE");
  assert.equal((await f.request(f.path, "GET", key)).status, 403);
});

test("oversized public bodies are rejected before the broad parser", async (t) => {
  const f = await runFixture(t);
  assert.equal((await f.request(`${f.path}/visits`, "POST", randomBytes(32).toString("hex"), { value: "x".repeat(4096) })).status, 413);
  assert.equal(f.visits.size, 0);
});

test("actual app gates both rankings and player history before accessing ranking data", async (t) => {
  const { prisma } = await import("../../src/lib/db.js");
  const { createApp } = await import("../../src/app.js");
  const token = randomUUID();
  const key = randomBytes(32).toString("hex");
  const now = new Date();
  const publication = { id: randomUUID(), publicToken: token, finalizedAt: now, sessionStartedAt: now, sessionEndedAt: now, finalSnapshot: { capturedAt: now.toISOString(), rankings: [] } };
  let granted = false;
  // Prisma's delegate methods are proxy getters, not mock.method-compatible descriptors.
  const originalPublicationRead = prisma.publicRankingPublication.findFirst;
  const originalVisitRead = prisma.publicRankingVisit.findFirst;
  prisma.publicRankingPublication.findFirst = (async () => publication) as typeof originalPublicationRead;
  prisma.publicRankingVisit.findFirst = (async () => granted ? { locationStatus: "GRANTED", accessExpiresAt: new Date(Date.now() + 10000), expiresAt: new Date(Date.now() + 10000) } : null) as typeof originalVisitRead;
  t.after(() => { prisma.publicRankingPublication.findFirst = originalPublicationRead; prisma.publicRankingVisit.findFirst = originalVisitRead; });
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v2/public/rankings/${token}`;
  for (const path of [base, `${base}/players/player-key/history`]) {
    const response = await fetch(path, { headers: { "x-ranking-visit-key": key } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "LOCATION_REQUIRED");
  }
  granted = true;
  assert.equal((await fetch(base, { headers: { "x-ranking-visit-key": key } })).status, 200);
  assert.equal((await fetch(`${base}/visits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ huge: "x".repeat(4097) }) })).status, 413);
});
