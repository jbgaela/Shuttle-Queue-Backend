import test from "node:test";
import assert from "node:assert/strict";
import { slidingIdleExpiry } from "../../src/lib/session-expiry.js";

test("slides the idle expiry from the current request", () => {
  const now = new Date("2026-08-30T00:00:00.000Z");
  const absolute = new Date("2026-08-31T00:00:00.000Z");
  assert.equal(slidingIdleExpiry(now, absolute, 720).toISOString(), "2026-08-30T12:00:00.000Z");
});

test("never extends a session beyond its absolute expiry", () => {
  const now = new Date("2026-08-30T23:00:00.000Z");
  const absolute = new Date("2026-08-31T00:30:00.000Z");
  assert.equal(slidingIdleExpiry(now, absolute, 720).toISOString(), absolute.toISOString());
});
