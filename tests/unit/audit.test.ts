import assert from "node:assert/strict";
import test from "node:test";
import { auditLogData } from "../../src/lib/audit.js";

test("audit payload maps snapshots to JSON fields and normalizes dates", () => {
  const data = auditLogData("queue-master", "request-id", {
    action: "PLAYER_UPDATED",
    entityType: "PLAYER",
    entityId: "player-id",
    reason: "Profile updated",
    before: { updatedAt: new Date("2026-08-22T00:00:00.000Z") },
    after: { updatedAt: new Date("2026-08-22T00:01:00.000Z") },
  });

  assert.deepEqual(data, {
    queueMasterId: "queue-master",
    action: "PLAYER_UPDATED",
    entityType: "PLAYER",
    entityId: "player-id",
    reason: "Profile updated",
    beforeJson: { updatedAt: "2026-08-22T00:00:00.000Z" },
    afterJson: { updatedAt: "2026-08-22T00:01:00.000Z" },
    requestId: "request-id",
  });
  assert.equal("before" in data, false);
  assert.equal("after" in data, false);
});

test("audit payload omits absent snapshots and preserves deleted-player entity mapping", () => {
  const data = auditLogData("queue-master", "request-id", {
    action: "PLAYERS_DELETED",
    entityType: "ACCOUNT",
    entityId: "queue-master",
  });

  assert.equal(data.entityType, "QUEUE_PLAYER");
  assert.equal("beforeJson" in data, false);
  assert.equal("afterJson" in data, false);
});
