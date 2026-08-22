import assert from "node:assert/strict";
import test from "node:test";
import { activePublicRankingWhere } from "../../src/lib/public-rankings.js";
import { publicRankingRowsFromSnapshot } from "../../src/lib/sync-persistence.js";

test("active public ranking filter includes null and missing revokedAt values", () => {
  assert.deepEqual(activePublicRankingWhere(), {
    enabled: true,
    OR: [{ revokedAt: null }, { revokedAt: { isSet: false } }],
  });
});

test("public ranking snapshots include every joined player and hide private fields", () => {
  const rows = publicRankingRowsFromSnapshot({ queuePlayers: [
    { displayName: "Zero", wins: 0, losses: 0, matchesPlayed: 0, pointsFor: 0, pointsAgainst: 0 },
    { displayName: "Winner", wins: 3, losses: 1, matchesPlayed: 4, pointsFor: 84, pointsAgainst: 70, gender: "MALE", skillLevel: "ADVANCED" },
  ] } as unknown as Parameters<typeof publicRankingRowsFromSnapshot>[0]);
  assert.deepEqual(rows, [
    { rank: 1, player: "Winner", matchesPlayed: 4, wins: 3, losses: 1, winRateBasisPoints: 7500, pointsFor: 84, pointsAgainst: 70, pointDifferential: 14 },
    { rank: 2, player: "Zero", matchesPlayed: 0, wins: 0, losses: 0, winRateBasisPoints: 0, pointsFor: 0, pointsAgainst: 0, pointDifferential: 0 },
  ]);
  assert.equal("gender" in rows[0]!, false);
  assert.equal("skillLevel" in rows[0]!, false);
});

test("public ranking snapshot ordering is deterministic for equal records", () => {
  const rows = publicRankingRowsFromSnapshot({ queuePlayers: [
    { displayName: "Beta", wins: 1, losses: 0, matchesPlayed: 1, pointsFor: 31, pointsAgainst: 20 },
    { displayName: "alpha", wins: 1, losses: 0, matchesPlayed: 1, pointsFor: 31, pointsAgainst: 20 },
  ] } as unknown as Parameters<typeof publicRankingRowsFromSnapshot>[0]);
  assert.deepEqual(rows.map((row) => row.player), ["alpha", "Beta"]);
});
