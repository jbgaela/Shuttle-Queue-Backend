import assert from "node:assert/strict";
import test from "node:test";
import type { CloudSnapshotV2 } from "@shuttle-queue/domain";
import { assertStableNaturalKeys, reconcileSyncSnapshot, validateSyncSnapshot } from "../../src/lib/sync-persistence.js";

const snapshot = (): CloudSnapshotV2 => ({
  schemaVersion: 2,
  queueMasterId: "account-1",
  settings: null,
  workspace: { startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, lateArrivalCutoffAt: null, matchmakingAlgorithm: "v2-rotation", matchmakingRevision: 1, version: 1 },
  players: [{ id: "player-1", displayName: "Alice", gender: "FEMALE", skillLevel: "INTERMEDIATE", skillWeight: 3, status: "ACTIVE" }],
  queuePlayers: [],
  courts: [],
  matches: [],
  feeConfig: null,
  payments: [],
  audits: [],
});

test("validates duplicate and missing snapshot identities before persistence", () => {
  const duplicate = snapshot();
  duplicate.players.push({ ...duplicate.players[0] });
  assert.throws(() => validateSyncSnapshot(duplicate), (error: any) => error.code === "SYNC_SNAPSHOT_CONFLICT" && error.details.field === "id");

  const duplicateName = snapshot();
  duplicateName.players.push({ ...duplicateName.players[0], id: "player-2", displayName: " alice " });
  assert.throws(() => validateSyncSnapshot(duplicateName), (error: any) => error.code === "SYNC_SNAPSHOT_CONFLICT" && error.details.field === "normalizedName");

  const missingReference = snapshot();
  missingReference.queuePlayers.push({ id: "queue-player-1", playerId: "missing", displayName: "Missing", gender: "FEMALE", skillLevel: "INTERMEDIATE", skillWeight: 3, status: "INACTIVE", queueEnteredAt: null, lastMatchEndedAt: null, matchesPlayed: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, amountDueMinor: 0, manualPriority: 0, priorityReason: null, latePenaltyState: null, latePenaltyAppliedAt: null, currentMatchId: null, checkedInAt: null, checkedOutAt: null, restStartedAt: null, version: 1 });
  assert.throws(() => validateSyncSnapshot(missingReference), (error: any) => error.code === "SYNC_SNAPSHOT_CONFLICT");
});

test("reports same-natural-key records with a different offline id", async () => {
  const tx = {
    player: { findMany: async () => [{ id: "cloud-player", displayName: "Alice" }] },
    queuePlayer: { findMany: async () => [] },
    court: { findMany: async () => [] },
    matchParticipant: { findMany: async () => [] },
    matchScoreRevision: { findMany: async () => [] },
    matchGame: { findMany: async () => [] },
  };
  await assert.rejects(() => assertStableNaturalKeys(tx, "account-1", snapshot()), (error: any) => error.code === "SYNC_IDENTITY_CONFLICT" && error.details.entity === "player");
});

test("updates existing records and deletes stale records without recreating them", async () => {
  const calls: string[] = [];
  const model = (ids: string[]) => ({
    findMany: async () => ids.map((id) => ({ id })),
    update: async () => { calls.push("update"); return {}; },
    create: async () => { calls.push("create"); return {}; },
    deleteMany: async () => { calls.push("delete"); return {}; },
  });
  const tx: any = {
    player: model(["player-1", "stale-player"]),
    queuePlayer: model([]),
    court: model([]),
    match: model([]),
    matchParticipant: model([]),
    matchScoreRevision: model([]),
    matchGame: model([]),
    payment: model([]),
    queueWorkspace: { update: async () => ({}) },
    queueFeeConfig: { deleteMany: async () => ({}) },
    auditLog: { create: async () => ({}) },
  };
  await reconcileSyncSnapshot(tx, "account-1", snapshot(), [], "operation-1");
  assert.equal(calls.filter((call) => call === "update").length, 1);
  assert.equal(calls.filter((call) => call === "create").length, 0);
  assert.ok(calls.includes("delete"));
});
