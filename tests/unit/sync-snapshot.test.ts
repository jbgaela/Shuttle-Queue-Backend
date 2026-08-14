import assert from "node:assert/strict";
import test from "node:test";
import { shouldRemoveFeeConfig, stalePlayerFilter } from "../../src/lib/sync-snapshot.js";

test("stale player filter removes cloud players absent from a non-empty local roster", () => {
  assert.deepEqual(stalePlayerFilter(["player-2", "player-3"]), { id: { notIn: ["player-2", "player-3"] } });
});

test("stale player filter matches every cloud player for an empty local roster", () => {
  assert.deepEqual(stalePlayerFilter([]), {});
});

test("fee configuration is removed only when the local snapshot has none", () => {
  assert.equal(shouldRemoveFeeConfig(null), true);
  assert.equal(shouldRemoveFeeConfig({ id: "fee-1" }), false);
});
