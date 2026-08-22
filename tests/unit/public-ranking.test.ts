import assert from "node:assert/strict";
import test from "node:test";
import { activePublicRankingWhere, isPublicRankingSnapshot, publicHistoryFromSnapshot, publicPlayerKey, publicRankingSnapshotFromCloudSnapshot, publicRankingSnapshotFromRecords } from "../../src/lib/public-rankings.js";
import { publicRankingRowsFromSnapshot } from "../../src/lib/sync-persistence.js";

test("active public ranking filter includes null and missing revokedAt values", () => {
  assert.deepEqual(activePublicRankingWhere(), {
    enabled: true,
    OR: [{ revokedAt: null }, { revokedAt: { isSet: false } }],
  });
});

test("public ranking snapshots include every joined player and hide private fields", () => {
  const rows = publicRankingRowsFromSnapshot({ queueMasterId: "queue", queuePlayers: [
    { id: "zero", displayName: "Zero", wins: 0, losses: 0, matchesPlayed: 0, pointsFor: 0, pointsAgainst: 0 },
    { id: "winner", displayName: "Winner", wins: 3, losses: 1, matchesPlayed: 4, pointsFor: 84, pointsAgainst: 70, gender: "MALE", skillLevel: "ADVANCED" },
  ] } as unknown as Parameters<typeof publicRankingRowsFromSnapshot>[0]);
  assert.deepEqual(rows, [
    { rank: 1, playerKey: publicPlayerKey("queue", "winner"), player: "Winner", matchesPlayed: 4, wins: 3, losses: 1, winRateBasisPoints: 7500, pointsFor: 84, pointsAgainst: 70, pointDifferential: 14 },
    { rank: 2, playerKey: publicPlayerKey("queue", "zero"), player: "Zero", matchesPlayed: 0, wins: 0, losses: 0, winRateBasisPoints: 0, pointsFor: 0, pointsAgainst: 0, pointDifferential: 0 },
  ]);
  assert.equal("gender" in rows[0]!, false);
  assert.equal("skillLevel" in rows[0]!, false);
});

test("public ranking snapshot ordering is deterministic for equal records", () => {
  const rows = publicRankingRowsFromSnapshot({ queueMasterId: "queue", queuePlayers: [
    { id: "beta", displayName: "Beta", wins: 1, losses: 0, matchesPlayed: 1, pointsFor: 31, pointsAgainst: 20 },
    { id: "alpha", displayName: "alpha", wins: 1, losses: 0, matchesPlayed: 1, pointsFor: 31, pointsAgainst: 20 },
  ] } as unknown as Parameters<typeof publicRankingRowsFromSnapshot>[0]);
  assert.deepEqual(rows.map((row) => row.player), ["alpha", "Beta"]);
});

test("public history snapshots use the current revision and expose compact team scores", () => {
  const snapshot = publicRankingSnapshotFromCloudSnapshot({
    queueMasterId: "queue",
    queuePlayers: [
      { id: "p1", displayName: "Alice", wins: 1, losses: 0, matchesPlayed: 1, pointsFor: 42, pointsAgainst: 35 },
      { id: "p2", displayName: "Bob", wins: 0, losses: 1, matchesPlayed: 1, pointsFor: 35, pointsAgainst: 42 },
    ],
    matches: [{
      id: "match-1",
      status: "COMPLETED",
      completedAt: "2025-01-02T12:00:00.000Z",
      winnerTeam: "A",
      currentRevisionId: "revision-2",
      participants: [
        { queuePlayerId: "p1", team: "A", teamSlot: 1 },
        { queuePlayerId: "p2", team: "B", teamSlot: 1 },
      ],
      scoreRevisions: [
        { id: "revision-1", winnerTeam: "B", games: [{ gameNumber: 1, teamAScore: 10, teamBScore: 21, winnerTeam: "B" }] },
        { id: "revision-2", winnerTeam: "A", games: [{ gameNumber: 2, teamAScore: 21, teamBScore: 19, winnerTeam: "A" }, { gameNumber: 1, teamAScore: 21, teamBScore: 17, winnerTeam: "A" }] },
      ],
    }],
  } as unknown as Parameters<typeof publicRankingSnapshotFromCloudSnapshot>[0], "publication", new Date("2025-01-02T12:01:00.000Z"));
  const playerKey = publicPlayerKey("publication", "p1");
  const history = publicHistoryFromSnapshot(snapshot, playerKey);
  assert.ok(history);
  assert.deepEqual(history.matches[0], {
    matchKey: snapshot.matches[0]!.matchKey,
    completedAt: "2025-01-02T12:00:00.000Z",
    winnerTeam: "A",
    games: [
      { gameNumber: 1, teamAScore: 21, teamBScore: 17, winnerTeam: "A" },
      { gameNumber: 2, teamAScore: 21, teamBScore: 19, winnerTeam: "A" },
    ],
    result: "WIN",
    teamA: ["Alice"],
    teamB: ["Bob"],
  });
  assert.equal("gender" in history.matches[0]!, false);
  assert.equal("participants" in history.matches[0]!, false);
  assert.equal("queueMasterId" in history.matches[0]!, false);
});

test("database and offline snapshot history mappers produce the same public match log", () => {
  const capturedAt = new Date("2025-01-02T12:01:00.000Z");
  const databaseSnapshot = publicRankingSnapshotFromRecords({
    publicationId: "publication",
    capturedAt,
    rows: [{ id: "p1", displayNameSnapshot: "Alice", wins: 1, losses: 0, matchesPlayed: 1, pointsFor: 42, pointsAgainst: 35 }],
    matches: [{ id: "match-1", status: "COMPLETED", completedAt: new Date("2025-01-02T12:00:00.000Z"), winnerTeam: "A", currentRevisionId: "revision-1", participants: [{ queuePlayerId: "p1", team: "A", teamSlot: 1, queuePlayer: { displayNameSnapshot: "Alice" } }], scoreRevisions: [{ id: "revision-1", winnerTeam: "A", games: [{ gameNumber: 1, teamAScore: 21, teamBScore: 18, winnerTeam: "A" }] }] }],
  });
  const cloudSnapshot = publicRankingSnapshotFromCloudSnapshot({ queueMasterId: "queue", queuePlayers: [{ id: "p1", displayName: "Alice", wins: 1, losses: 0, matchesPlayed: 1, pointsFor: 42, pointsAgainst: 35 }], matches: [{ id: "match-1", status: "COMPLETED", completedAt: "2025-01-02T12:00:00.000Z", winnerTeam: "A", currentRevisionId: "revision-1", participants: [{ queuePlayerId: "p1", team: "A", teamSlot: 1 }], scoreRevisions: [{ id: "revision-1", winnerTeam: "A", games: [{ gameNumber: 1, teamAScore: 21, teamBScore: 18, winnerTeam: "A" }] }] }] } as unknown as Parameters<typeof publicRankingSnapshotFromCloudSnapshot>[0], "publication", capturedAt);
  assert.deepEqual(databaseSnapshot.matches, cloudSnapshot.matches);
  assert.equal(isPublicRankingSnapshot(databaseSnapshot), true);
  assert.equal(isPublicRankingSnapshot({ capturedAt: capturedAt.toISOString(), rankings: databaseSnapshot.rankings }), false);
  assert.equal(publicHistoryFromSnapshot(databaseSnapshot, "unknown"), null);
});
