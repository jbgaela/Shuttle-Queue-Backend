import assert from "node:assert/strict";
import test from "node:test";
import { activePublicRankingWhere, earliestMatchStartedAt, isPublicRankingSnapshot, publicHistoryFromSnapshot, publicPlayerKey, publicRankingSnapshotFromCloudSnapshot, publicRankingSnapshotFromRecords, recalculatePublicRankingRows } from "../../src/lib/public-rankings.js";
import { publicRankingRowsFromSnapshot } from "../../src/lib/sync-persistence.js";

test("active public ranking filter includes null and missing revokedAt values", () => {
  assert.deepEqual(activePublicRankingWhere(), {
    enabled: true,
    OR: [{ revokedAt: null }, { revokedAt: { isSet: false } }],
  });
});

test("earliest match start ignores queued matches and normalizes Date and ISO values", () => {
  assert.equal(earliestMatchStartedAt([
    { startedAt: null },
    { startedAt: "2025-01-02T12:00:00.000Z" },
    { startedAt: new Date("2025-01-02T11:00:00.000Z") },
    {},
    { startedAt: "2025-01-02T13:00:00.000Z" },
  ]), "2025-01-02T11:00:00.000Z");
  assert.equal(earliestMatchStartedAt([{ startedAt: null }, {}]), null);
});

test("cancelled matches with a start timestamp count as the first match", () => {
  assert.equal(earliestMatchStartedAt([
    { startedAt: "2025-01-02T12:00:00.000Z" },
    { startedAt: "2025-01-02T11:00:00.000Z" },
  ]), "2025-01-02T11:00:00.000Z");
});

test("public ranking snapshots include every joined player and hide private fields", () => {
  const rows = publicRankingRowsFromSnapshot({ queueMasterId: "queue", queuePlayers: [
    { id: "zero", displayName: "Zero", wins: 0, losses: 0, matchesPlayed: 0, pointsFor: 0, pointsAgainst: 0 },
    { id: "winner", displayName: "Winner", wins: 3, losses: 1, matchesPlayed: 4, pointsFor: 84, pointsAgainst: 70, gender: "MALE", skillLevel: "ADVANCED" },
  ] } as unknown as Parameters<typeof publicRankingRowsFromSnapshot>[0]);
  assert.deepEqual(rows, [
    { rank: null, playerKey: publicPlayerKey("queue", "winner"), player: "Winner", matchesPlayed: 4, wins: 3, losses: 1, winRateBasisPoints: 7500, pointsFor: 84, pointsAgainst: 70, pointDifferential: 14, eligible: false, gamesNeeded: 1, rankingScoreBasisPoints: null, pointPercentageBasisPoints: null, isPrizePosition: false, seededDrawUsed: false },
    { rank: null, playerKey: publicPlayerKey("queue", "zero"), player: "Zero", matchesPlayed: 0, wins: 0, losses: 0, winRateBasisPoints: 0, pointsFor: 0, pointsAgainst: 0, pointDifferential: 0, eligible: false, gamesNeeded: 5, rankingScoreBasisPoints: null, pointPercentageBasisPoints: null, isPrizePosition: false, seededDrawUsed: false },
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
    matches: [{ id: "match-1", status: "COMPLETED", startedAt: new Date("2025-01-02T11:00:00.000Z"), completedAt: new Date("2025-01-02T12:00:00.000Z"), winnerTeam: "A", currentRevisionId: "revision-1", participants: [{ queuePlayerId: "p1", team: "A", teamSlot: 1, queuePlayer: { displayNameSnapshot: "Alice" } }], scoreRevisions: [{ id: "revision-1", winnerTeam: "A", games: [{ gameNumber: 1, teamAScore: 21, teamBScore: 18, winnerTeam: "A" }] }] }],
  });
  const cloudSnapshot = publicRankingSnapshotFromCloudSnapshot({ queueMasterId: "queue", queuePlayers: [{ id: "p1", displayName: "Alice", wins: 1, losses: 0, matchesPlayed: 1, pointsFor: 42, pointsAgainst: 35 }], matches: [{ id: "match-1", status: "COMPLETED", startedAt: "2025-01-02T11:00:00.000Z", completedAt: "2025-01-02T12:00:00.000Z", winnerTeam: "A", currentRevisionId: "revision-1", participants: [{ queuePlayerId: "p1", team: "A", teamSlot: 1 }], scoreRevisions: [{ id: "revision-1", winnerTeam: "A", games: [{ gameNumber: 1, teamAScore: 21, teamBScore: 18, winnerTeam: "A" }] }] }] } as unknown as Parameters<typeof publicRankingSnapshotFromCloudSnapshot>[0], "publication", capturedAt);
  assert.deepEqual(databaseSnapshot.matches, cloudSnapshot.matches);
  assert.equal(databaseSnapshot.firstMatchStartedAt, "2025-01-02T11:00:00.000Z");
  assert.equal(cloudSnapshot.firstMatchStartedAt, databaseSnapshot.firstMatchStartedAt);
  assert.equal(isPublicRankingSnapshot(databaseSnapshot), true);
  assert.equal(isPublicRankingSnapshot({ capturedAt: capturedAt.toISOString(), rankings: databaseSnapshot.rankings }), false);
  assert.equal(publicHistoryFromSnapshot(databaseSnapshot, "unknown"), null);
});

test("offline snapshots preserve the earliest started match even when it is not completed", () => {
  const snapshot = publicRankingSnapshotFromCloudSnapshot({
    queueMasterId: "queue",
    queuePlayers: [],
    matches: [
      { id: "queued", status: "QUEUED", startedAt: null },
      { id: "cancelled", status: "CANCELLED", startedAt: "2025-01-02T10:00:00.000Z" },
      { id: "playing", status: "IN_PROGRESS", startedAt: "2025-01-02T11:00:00.000Z" },
    ],
  } as unknown as Parameters<typeof publicRankingSnapshotFromCloudSnapshot>[0], "publication", new Date("2025-01-02T12:00:00.000Z"));
  assert.equal(snapshot.firstMatchStartedAt, "2025-01-02T10:00:00.000Z");
  assert.deepEqual(snapshot.matches, []);
});

test("public rankings apply the five-game rule and confidence score to archived rows", () => {
  const rows = recalculatePublicRankingRows([
    { playerKey: "perfect", player: "Perfect", matchesPlayed: 5, wins: 5, losses: 0, pointsFor: 105, pointsAgainst: 50 },
    { playerKey: "strong", player: "Strong", matchesPlayed: 10, wins: 9, losses: 1, pointsFor: 189, pointsAgainst: 120 },
    { playerKey: "short", player: "Short", matchesPlayed: 4, wins: 4, losses: 0, pointsFor: 84, pointsAgainst: 30 },
  ], "2026-08-30T10:00:00.000Z");
  assert.equal(rows[0]!.player, "Strong");
  assert.equal(rows[0]!.isPrizePosition, true);
  assert.equal(rows[2]!.rank, null);
  assert.equal(rows[2]!.gamesNeeded, 1);
});
