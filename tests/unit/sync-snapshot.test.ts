import assert from "node:assert/strict";
import test from "node:test";
import { QueuePlayerStatus } from "@prisma/client";
import type { CloudSnapshotV2 } from "@shuttle-queue/domain";
import { snapshotQueueSummaries } from "../../src/lib/sync-snapshot.js";

const snapshot = (matches: CloudSnapshotV2["matches"]) => ({ matches }) as CloudSnapshotV2;

const match = (
  id: string,
  status: "IN_PROGRESS" | "QUEUED",
  queuedAt: string,
  ...queuePlayerIds: string[]
) =>
  ({
    id,
    status,
    queuedAt,
    participants: queuePlayerIds.map((queuePlayerId) => ({ queuePlayerId })),
  }) as CloudSnapshotV2["matches"][number];

test("indexes active and earliest queued match summaries in one pass", () => {
  const summaries = snapshotQueueSummaries(
    snapshot([
      match("queued-later", "QUEUED", "2026-01-01T10:00:00.000Z", "queue-1", "queue-2"),
      match("queued-first-b", "QUEUED", "2026-01-01T09:00:00.000Z", "queue-1"),
      match("queued-first-a", "QUEUED", "2026-01-01T09:00:00.000Z", "queue-1"),
      match("active", "IN_PROGRESS", "2026-01-01T08:00:00.000Z", "queue-2"),
    ]),
  );

  assert.deepEqual(summaries.get("queue-1"), {
    status: QueuePlayerStatus.QUEUED,
    currentMatchId: "queued-first-a",
  });
  assert.deepEqual(summaries.get("queue-2"), {
    status: QueuePlayerStatus.PLAYING,
    currentMatchId: "active",
  });
  assert.equal(summaries.get("queue-missing"), undefined);
});

test("rejects a player assigned to different active matches", () => {
  assert.throws(
    () =>
      snapshotQueueSummaries(
        snapshot([
          match("active-1", "IN_PROGRESS", "2026-01-01T08:00:00.000Z", "queue-1"),
          match("active-2", "IN_PROGRESS", "2026-01-01T08:00:00.000Z", "queue-1"),
        ]),
      ),
    (error: any) => error.code === "VALIDATION_ERROR",
  );
});
