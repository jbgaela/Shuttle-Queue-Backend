import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { hasLocationAccess, locationInputSchema, reportedDevice, trackingBefore, trackingCursor, trackingHash, trackingPage, verifyRankingEdge, visitKeyHash, VISIT_RETENTION_MS } from "../../src/lib/ranking-tracking.js";

test("signed edge metadata authenticates the request path, method, body and visitor", () => {
  const secret = randomBytes(32).toString("hex");
  const now = Date.now();
  const visitor = { timestamp: now, requestId: "edge-request", ip: "2001:db8::1", userAgent: "Browser", city: "Manila", region: "Metro Manila", country: "Philippines" };
  const metadata = Buffer.from(JSON.stringify(visitor)).toString("base64url");
  const base = { secret, metadata, method: "POST", path: "/api/v2/public/rankings/example/visits", body: Buffer.from("{}") };
  const signature = createHmac("sha256", secret).update([base.method, base.path, trackingHash(base.body), metadata].join("\n")).digest("hex");
  assert.deepEqual(verifyRankingEdge({ ...base, signature }, now), visitor);
  for (const changed of [{ method: "PATCH" }, { path: base.path + "?changed=1" }, { body: Buffer.from('{"ip":"127.0.0.1"}') }, { metadata: metadata + "a" }, { signature: "0".repeat(64) }]) {
    assert.throws(() => verifyRankingEdge({ ...base, signature, ...changed }, now), /could not be verified/);
  }
  assert.throws(() => verifyRankingEdge({ ...base, signature }, now + 60_001));
  assert.throws(() => verifyRankingEdge({ ...base, signature }, now - 60_001));
  assert.throws(() => verifyRankingEdge({ ...base, signature: "short" }, now));
});

test("visit keys have 256 bits and are stored as hashes", () => {
  const key = randomBytes(32).toString("hex");
  assert.equal(visitKeyHash(key), trackingHash(key));
  assert.notEqual(visitKeyHash(key), key);
  for (const key of [undefined, "short", "x".repeat(64), "a".repeat(65)]) assert.throws(() => visitKeyHash(key));
});

test("location validation rejects malformed or out-of-range coordinates", () => {
  assert.equal(locationInputSchema.safeParse({ status: "GRANTED", latitude: 14.6, longitude: 121, accuracy: 12 }).success, true);
  for (const values of [{ latitude: 91 }, { longitude: -181 }, { accuracy: -1 }, { latitude: NaN }, { longitude: Infinity }, { accuracy: "3" }]) {
    assert.equal(locationInputSchema.safeParse({ status: "GRANTED", latitude: 14, longitude: 121, accuracy: 10, ...values }).success, false);
  }
  assert.equal(locationInputSchema.safeParse({ status: "DENIED", latitude: 14 }).success, false);
});

test("access requires an unexpired accepted location and retained visit", () => {
  const now = new Date();
  const visit = { locationStatus: "GRANTED", accessExpiresAt: new Date(now.getTime() + 1000), expiresAt: new Date(now.getTime() + VISIT_RETENTION_MS) };
  assert.equal(hasLocationAccess(visit, now), true);
  for (const values of [{ locationStatus: "PENDING" }, { locationStatus: "DENIED" }, { accessExpiresAt: null }, { accessExpiresAt: now }, { expiresAt: now }]) assert.equal(hasLocationAccess({ ...visit, ...values }, now), false);
  assert.equal(hasLocationAccess(null, now), false);
});

test("cursor preserves a timestamp/id tie-break and bounds page sizes", () => {
  const at = new Date("2026-09-22T08:00:00Z"); const id = randomUUID();
  const page = trackingPage({ cursor: trackingCursor(at, id), limit: "50", status: "DENIED" });
  assert.deepEqual(trackingBefore("openedAt", page.cursor), { OR: [{ openedAt: { lt: at } }, { openedAt: at, id: { lt: id } }] });
  assert.throws(() => trackingPage({ limit: 101 }));
  assert.throws(() => trackingPage({ cursor: "invalid" }));
  assert.throws(() => trackingPage({ status: "invented" }));
});

test("device parser recognizes browsers and tolerates unknown user agents", () => {
  const mobile = reportedDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
  assert.equal(mobile.device, "mobile"); assert.match(mobile.operatingSystem, /iOS/); assert.match(mobile.browser, /Safari/);
  assert.equal(reportedDevice("").device, "unknown");
});
