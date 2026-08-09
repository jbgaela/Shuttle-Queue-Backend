import assert from "node:assert/strict";
import test from "node:test";
import { Gender, MatchmakingMode, SessionPlayerStatus, TeamSide } from "@prisma/client";
import { allocateEqualSplit, collectionTotalsByPlayer } from "../../src/lib/fees.js";
import { chooseFrequentParticipant, historyDurationSeconds, historyMatchView } from "../../src/lib/history.js";
import { suggestMatch, type MatchPlayer } from "../../src/lib/matchmaking.js";
import { validateScores } from "../../src/lib/score.js";

const history = { partners: new Map(), opponents: new Map(), quartets: new Map() };
const player = (id: string, gender: Gender, skillWeight: number, queueEnteredAt = new Date("2026-01-01T00:00:00Z")): MatchPlayer => ({ id, displayName: id, gender, skillWeight, skillLevel: "BEGINNER", status: SessionPlayerStatus.WAITING, gamesPlayed: 0, queueEnteredAt, lastMatchEndedAt: null, manualPriority: 0 });
const pairMap = (...pairs: [string, string, number][]) => new Map(pairs.map(([left, right, value]) => [left, new Map([[right, value]])]));

test("race-to-31 scores require a valid winner", () => {
  const result = validateScores([{ teamAScore: 31, teamBScore: 29 }], { pointsToWin: 31, winBy: 1, scoreCap: 31, bestOf: 1 });
  assert.equal(result[0]?.winnerTeam, TeamSide.A);
  assert.throws(() => validateScores([{ teamAScore: 30, teamBScore: 29 }], { pointsToWin: 31, winBy: 1, scoreCap: 31, bestOf: 1 }));
});

test("score validation rejects ties and caps, and completes best-of-3", () => {
  const settings = { pointsToWin: 31, winBy: 1, scoreCap: 31, bestOf: 3 };
  const result = validateScores([
    { teamAScore: 31, teamBScore: 24 },
    { teamAScore: 25, teamBScore: 31 },
    { teamAScore: 31, teamBScore: 29 },
  ], settings);
  assert.equal(result.length, 3);
  assert.equal(result[2]?.winnerTeam, TeamSide.A);
  assert.throws(() => validateScores([{ teamAScore: 31, teamBScore: 31 }], { ...settings, bestOf: 1 }));
  assert.throws(() => validateScores([{ teamAScore: 32, teamBScore: 30 }], { ...settings, bestOf: 1 }));
});

test("equal split allocates the remainder deterministically", () => {
  assert.deepEqual([...allocateEqualSplit(101, ["b", "a", "c"]).entries()], [["a", 34], ["b", 34], ["c", 33]]);
});

test("collection totals group valid methods and ignore non-collections", () => {
  const totals = collectionTotalsByPlayer([
    { sessionPlayerId: "alice", kind: "COLLECTION", method: "CASH", amountMinor: 500 },
    { sessionPlayerId: "alice", kind: "COLLECTION", method: "EWALLET", amountMinor: 250 },
    { sessionPlayerId: "alice", kind: "COLLECTION", method: "OTHER", amountMinor: 100 },
    { sessionPlayerId: "alice", kind: "WAIVER", method: null, amountMinor: 999 },
    { sessionPlayerId: "bob", kind: "COLLECTION", method: "EWALLET", amountMinor: 700 },
  ]);
  assert.deepEqual(totals.get("alice"), { CASH: 500, EWALLET: 250, OTHER: 100 });
  assert.deepEqual(totals.get("bob"), { CASH: 0, EWALLET: 700, OTHER: 0 });
  assert.equal(totals.has("missing"), false);
});

test("mixed doubles suggestion returns two players per gendered team", () => {
  const result = suggestMatch([player("a", Gender.MALE, 2), player("b", Gender.MALE, 3), player("c", Gender.FEMALE, 2), player("d", Gender.FEMALE, 3)], MatchmakingMode.MIXED_DOUBLES, history);
  assert.ok(result);
  assert.equal(result.teamA.length, 2);
  assert.equal(new Set(result.teamA.map((item) => item.gender)).size, 2);
  assert.equal(new Set(result.teamB.map((item) => item.gender)).size, 2);
});

test("rotation avoids an exact quartet that has already played together", () => {
  const players = ["a", "b", "c", "d", "e"].map((id) => player(id, Gender.MALE, 2));
  const result = suggestMatch(players, MatchmakingMode.OPEN, {
    partners: pairMap(["a", "b", 2]),
    opponents: new Map(),
    quartets: new Map([["a:b:c:d", 3]]),
  });
  assert.ok(result);
  assert.equal(new Set([...result.teamA, ...result.teamB].map((item) => item.id)).has("e"), true);
});

test("fairness includes the lowest-games players and avoids a player more than one game ahead", () => {
  const players = [
    { ...player("a", Gender.MALE, 2), gamesPlayed: 0 },
    { ...player("b", Gender.MALE, 2), gamesPlayed: 0 },
    { ...player("c", Gender.MALE, 2), gamesPlayed: 0 },
    { ...player("d", Gender.MALE, 2), gamesPlayed: 1 },
    { ...player("e", Gender.MALE, 2), gamesPlayed: 1 },
    { ...player("f", Gender.MALE, 2), gamesPlayed: 1 },
    { ...player("g", Gender.MALE, 2), gamesPlayed: 1 },
    { ...player("h", Gender.MALE, 2), gamesPlayed: 3 },
    { ...player("i", Gender.MALE, 2), gamesPlayed: 3 },
  ];
  const result = suggestMatch(players, MatchmakingMode.OPEN, history);
  assert.ok(result);
  assert.deepEqual([...result.teamA, ...result.teamB].map((item) => item.id).sort(), ["a", "b", "c", "d"]);
});

test("recent partner repeats outrank older all-time repeats", () => {
  const players = ["a", "b", "c", "d"].map((id) => player(id, Gender.MALE, 2));
  const result = suggestMatch(players, MatchmakingMode.OPEN, {
    partners: pairMap(["a", "b", 1], ["a", "c", 5], ["b", "d", 5], ["a", "d", 5], ["b", "c", 5]),
    opponents: new Map(),
    quartets: new Map(),
    recentPartners: pairMap(["a", "b", 1]),
    recentOpponents: new Map(),
  });
  assert.ok(result);
  assert.equal(result.teamA.some((item) => item.id === "a") && result.teamA.some((item) => item.id === "b"), false);
  assert.equal(result.teamB.some((item) => item.id === "a") && result.teamB.some((item) => item.id === "b"), false);
});

test("balanced mode mixes stronger and weaker partners when team totals are equal", () => {
  const result = suggestMatch([
    player("a", Gender.MALE, 1),
    player("b", Gender.MALE, 1),
    player("c", Gender.MALE, 5),
    player("d", Gender.MALE, 5),
  ], MatchmakingMode.BALANCED, history);
  assert.ok(result);
  assert.equal(result.teamATotal, 6);
  assert.equal(result.teamBTotal, 6);
  assert.equal(new Set(result.teamA.map((item) => item.skillWeight)).size, 2);
  assert.equal(new Set(result.teamB.map((item) => item.skillWeight)).size, 2);
});

test("same-skill mode keeps hard eligibility and exclusions cycle through another split", () => {
  const players = ["a", "b", "c", "d"].map((id) => player(id, Gender.MALE, 2));
  assert.equal(suggestMatch([...players.slice(0, 3), player("d", Gender.MALE, 3)], MatchmakingMode.SAME_SKILL, history), null);
  const first = suggestMatch(players, MatchmakingMode.OPEN, history);
  assert.ok(first);
  const next = suggestMatch(players, MatchmakingMode.OPEN, history, [first.key]);
  assert.ok(next);
  assert.notEqual(next.key, first.key);
});

test("history formatting uses the current score revision and calculates duration", () => {
  const startedAt = new Date("2026-01-01T00:00:00Z");
  const completedAt = new Date("2026-01-01T00:02:31Z");
  const result = historyMatchView({
    id: "match-1",
    sessionId: "session-1",
    source: "MANUAL",
    currentRevisionId: "revision-2",
    startedAt,
    completedAt,
    participants: [
      { sessionPlayerId: "a", team: "A", teamSlot: 1, sessionPlayer: { playerId: "player-a", displayNameSnapshot: "Alice", genderSnapshot: Gender.FEMALE, skillLevelSnapshot: "BEGINNER" } },
      { sessionPlayerId: "b", team: "B", teamSlot: 1, sessionPlayer: { playerId: "player-b", displayNameSnapshot: "Bob", genderSnapshot: Gender.MALE, skillLevelSnapshot: "INTERMEDIATE" } },
    ],
    scoreRevisions: [
      { id: "revision-1", revisionNumber: 1, winnerTeam: "A", games: [{ gameNumber: 1, teamAScore: 31, teamBScore: 20, winnerTeam: "A" }] },
      { id: "revision-2", revisionNumber: 2, winnerTeam: "B", games: [{ gameNumber: 1, teamAScore: 25, teamBScore: 31, winnerTeam: "B" }] },
    ],
    winnerTeam: "B",
    court: { id: "court-1", name: "Court 1" },
  });
  assert.equal(result.format, "SINGLES");
  assert.equal(result.durationSeconds, 151);
  assert.equal(result.winnerTeam, "B");
  assert.equal(result.score?.revisionNumber, 2);
  assert.equal(result.score?.games[0]?.teamBScore, 31);
  assert.equal(historyDurationSeconds({ startedAt, completedAt: null }), null);
});

test("history frequent-player ties resolve by display name", () => {
  const result = chooseFrequentParticipant(new Map([
    ["b", { sessionPlayerId: "b", displayName: "Zoe", count: 2 }],
    ["a", { sessionPlayerId: "a", displayName: "Amy", count: 2 }],
  ]));
  assert.equal(result?.displayName, "Amy");
});
