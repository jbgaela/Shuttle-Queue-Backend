import assert from "node:assert/strict";
import test from "node:test";
import { normalizeQueuePlayerSnapshotFields, shouldRemoveFeeConfig, stalePlayerFilter } from "../../src/lib/sync-snapshot.js";

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

test("normalizes omitted legacy queue-player fields while preserving supplied values", () => {
  const snapshot = { queuePlayers: [{ id: "qp1", amountDueMinor: 25, latePenaltyState: "PENDING" }] };
  const normalized = normalizeQueuePlayerSnapshotFields(snapshot) as { queuePlayers: Array<Record<string, unknown>> };
  const player = normalized.queuePlayers[0]!;

  assert.equal(player.amountDueMinor, 25);
  assert.equal(player.latePenaltyState, "PENDING");
  assert.equal(player.priorityReason, null);
  assert.equal(player.currentMatchId, null);
  assert.equal(player.restStartedAt, null);
  assert.equal((snapshot.queuePlayers[0] as Record<string, unknown>).priorityReason, undefined);
});

test("does not turn invalid supplied values into valid defaults", () => {
  const normalized = normalizeQueuePlayerSnapshotFields({ queuePlayers: [{ amountDueMinor: null, latePenaltyState: "INVALID" }] }) as { queuePlayers: Array<Record<string, unknown>> };
  assert.equal(normalized.queuePlayers[0]!.amountDueMinor, null);
  assert.equal(normalized.queuePlayers[0]!.latePenaltyState, "INVALID");
});
