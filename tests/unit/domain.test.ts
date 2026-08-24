import assert from "node:assert/strict";
import test from "node:test";
import { Gender, MatchmakingMode, QueuePlayerStatus, TeamSide } from "@prisma/client";
import { allocateEqualSplit, collectionTotalsByPlayer } from "../../src/lib/fees.js";
import { allowedQueueStatuses, queueActionData } from "../../src/lib/queue-actions.js";
import { chooseFrequentParticipant, historyDurationSeconds, historyMatchView } from "../../src/lib/history.js";
import { isProhibitedGeneratedGenderMatch, suggestMatch, validateBalancedLineup, type MatchPlayer } from "../../src/lib/matchmaking.js";
import { validateScores } from "../../src/lib/score.js";
import { datePartsForInstant, inclusiveMinuteCutoff, instantForLocalDateTime } from "../../src/lib/timezone.js";

const history = { partners: new Map(), opponents: new Map(), quartets: new Map() };
const player = (id: string, gender: Gender, skillWeight: number, queueEnteredAt = new Date("2026-01-01T00:00:00Z")): MatchPlayer => ({ id, displayName: id, gender, skillWeight, skillLevel: "BEGINNER", status: QueuePlayerStatus.WAITING, gamesPlayed: 0, queueEnteredAt, lastMatchEndedAt: null, manualPriority: 0 });
const pairMap = (...pairs: [string, string, number][]) => new Map(pairs.map(([left, right, value]) => [left, new Map([[right, value]])]));

test("race-to-31 scores require a valid winner", () => {
  const result = validateScores([{ teamAScore: 31, teamBScore: 29 }], { pointsToWin: 31, winBy: 1, scoreCap: 31, bestOf: 1 });
  assert.equal(result[0]?.winnerTeam, TeamSide.A);
  assert.equal(validateScores([{ teamAScore: 31, teamBScore: 29 }], { pointsToWin: 31, winBy: 1, scoreCap: null, bestOf: 1 })[0]?.winnerTeam, TeamSide.A);
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
  assert.throws(() => validateScores([{ teamAScore: 32, teamBScore: 30 }], { ...settings, scoreCap: null }));
});

test("equal split allocates the remainder deterministically", () => {
  assert.deepEqual([...allocateEqualSplit(101, ["b", "a", "c"]).entries()], [["a", 34], ["b", 34], ["c", 33]]);
});

test("bulk queue actions preserve first check-in and apply one batch timestamp", () => {
  const changedAt = new Date("2026-02-01T10:00:00Z");
  const inclusiveCutoff = new Date("2026-02-01T10:00:59.999Z");
  assert.deepEqual(allowedQueueStatuses("CHECK_IN"), ["INACTIVE", "CHECKED_OUT"]);
  assert.deepEqual(queueActionData({ checkedInAt: null, latePenaltyState: null }, "CHECK_IN", changedAt, new Date("2026-01-01T09:00:00Z")), { status: "WAITING", checkedInAt: changedAt, checkedOutAt: null, queueEnteredAt: changedAt, latePenaltyState: "PENDING", latePenaltyAppliedAt: changedAt });
  assert.deepEqual(queueActionData({ checkedInAt: new Date("2026-01-01T08:00:00Z"), latePenaltyState: null }, "CHECK_IN", changedAt, new Date("2026-01-01T09:00:00Z")), { status: "WAITING", checkedInAt: new Date("2026-01-01T08:00:00Z"), checkedOutAt: null, queueEnteredAt: changedAt });
  assert.deepEqual(queueActionData({ checkedInAt: null, latePenaltyState: null }, "CHECK_IN", changedAt, changedAt), { status: "WAITING", checkedInAt: changedAt, checkedOutAt: null, queueEnteredAt: changedAt });
  assert.deepEqual(queueActionData({ checkedInAt: null, latePenaltyState: "WAIVED" }, "CHECK_IN", changedAt, new Date("2026-01-01T09:00:00Z")), { status: "WAITING", checkedInAt: changedAt, checkedOutAt: null, queueEnteredAt: changedAt });
  assert.equal(queueActionData({ checkedInAt: null, latePenaltyState: null }, "CHECK_IN", inclusiveCutoff, inclusiveCutoff).latePenaltyState, undefined);
  assert.equal(queueActionData({ checkedInAt: null, latePenaltyState: null }, "CHECK_IN", new Date(inclusiveCutoff.getTime() + 1), inclusiveCutoff).latePenaltyState, "PENDING");
  assert.deepEqual(queueActionData({}, "REST", changedAt), { status: "RESTING", restStartedAt: changedAt });
  assert.deepEqual(queueActionData({}, "CHECK_OUT", changedAt), { status: "CHECKED_OUT", checkedOutAt: changedAt, queueEnteredAt: null });
});

test("late-arrival wall clocks use the account timezone across UTC date boundaries", () => {
  assert.equal(datePartsForInstant(new Date("2026-08-14T17:00:00.000Z"), "Asia/Manila"), "2026-08-15");
  assert.equal(instantForLocalDateTime("2026-08-15T22:00", "Asia/Manila").toISOString(), "2026-08-15T14:00:00.000Z");
  assert.equal(instantForLocalDateTime("2026-08-15T00:00", "Asia/Manila").toISOString(), "2026-08-14T16:00:00.000Z");
  assert.equal(inclusiveMinuteCutoff("2026-08-15T22:00", "Asia/Manila").toISOString(), "2026-08-15T14:00:59.999Z");
});

test("collection totals group valid methods and ignore non-collections", () => {
  const totals = collectionTotalsByPlayer([
    { queuePlayerId: "alice", kind: "COLLECTION", method: "CASH", amountMinor: 500 },
    { queuePlayerId: "alice", kind: "COLLECTION", method: "EWALLET", amountMinor: 250 },
    { queuePlayerId: "alice", kind: "COLLECTION", method: "OTHER", amountMinor: 100 },
    { queuePlayerId: "alice", kind: "WAIVER", method: null, amountMinor: 999 },
    { queuePlayerId: "bob", kind: "COLLECTION", method: "EWALLET", amountMinor: 700 },
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

test("generated doubles reject a female-only team against a male-only team", () => {
  const female = [player("f1", Gender.FEMALE, 2), player("f2", Gender.FEMALE, 2)];
  const male = [player("m1", Gender.MALE, 2), player("m2", Gender.MALE, 2)];
  assert.equal(isProhibitedGeneratedGenderMatch(female, male), true);
  assert.equal(isProhibitedGeneratedGenderMatch([female[0]!, male[0]!], [female[1]!, male[1]!]), false);
  assert.equal(validateBalancedLineup(female, male, 1), null);
  const result = suggestMatch([...female, ...male], MatchmakingMode.OPEN, history);
  assert.ok(result);
  assert.equal(isProhibitedGeneratedGenderMatch(result.teamA, result.teamB), false);
});

test("late penalties are minimized before existing fairness rules", () => {
  const players = ["a", "b", "c", "d", "e"].map((id) => player(id, Gender.MALE, 2));
  players[4]!.latePenaltyState = "PENDING";
  const preferred = suggestMatch(players, MatchmakingMode.OPEN, history);
  assert.ok(preferred);
  assert.equal([...preferred.teamA, ...preferred.teamB].some((item) => item.id === "e"), false);
  const required = suggestMatch(players.filter((item) => item.id !== "d"), MatchmakingMode.OPEN, history);
  assert.ok(required);
  assert.equal([...required.teamA, ...required.teamB].some((item) => item.id === "e"), true);
});

test("games-played fairness outranks pending late preference", () => {
  const players = ["a", "b", "c", "d"].map((id) => ({ ...player(id, Gender.MALE, 2), gamesPlayed: 1 }));
  players.push({ ...player("e", Gender.MALE, 2), gamesPlayed: 0, latePenaltyState: "PENDING" });
  const result = suggestMatch(players, MatchmakingMode.OPEN, history);
  assert.ok(result);
  assert.equal([...result.teamA, ...result.teamB].some((item) => item.id === "e"), true);
  assert.equal((result.explanation.fairness as { minimumGames: number }).minimumGames, 0);
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

test("balanced mode keeps player and team strength gaps within one", () => {
  const result = suggestMatch([
    player("a", Gender.MALE, 2),
    player("b", Gender.MALE, 2),
    player("c", Gender.MALE, 3),
    player("d", Gender.MALE, 3),
  ], MatchmakingMode.BALANCED, history);
  assert.ok(result);
  assert.ok(result.difference <= 1);
  assert.ok(Math.max(...[...result.teamA, ...result.teamB].map((item) => item.skillWeight)) - Math.min(...[...result.teamA, ...result.teamB].map((item) => item.skillWeight)) <= 1);

  const boundary = suggestMatch([
    player("a", Gender.MALE, 2),
    player("b", Gender.MALE, 2),
    player("c", Gender.MALE, 2),
    player("d", Gender.MALE, 3),
  ], MatchmakingMode.BALANCED, history);
  assert.ok(boundary);
  assert.equal(boundary.difference, 1);
});

test("balanced +2/+3 variants and rest boundary are enforced", () => {
  assert.equal(suggestMatch([player("a", Gender.MALE, 1), player("b", Gender.MALE, 1), player("c", Gender.MALE, 3), player("d", Gender.MALE, 3)], MatchmakingMode.BALANCED, history), null);
  assert.ok(suggestMatch([player("a", Gender.MALE, 1), player("b", Gender.MALE, 1), player("c", Gender.MALE, 3), player("d", Gender.MALE, 3)], MatchmakingMode.BALANCED, history, [], { strengthGap: 2 }));
  const rested = ["a", "b", "c", "d"].map((id) => player(id, Gender.MALE, 2));
  rested[0]!.lastMatchEndedAt = new Date("2026-01-01T09:30:00Z");
  assert.equal(suggestMatch(rested, MatchmakingMode.OPEN, history, [], { minimumRestMinutes: 30, now: new Date("2026-01-01T09:29:59Z") }), null);
  assert.ok(suggestMatch(rested, MatchmakingMode.OPEN, history, [], { minimumRestMinutes: 30, now: new Date("2026-01-01T10:00:00Z") }));
});

test("balanced suggestions prioritize players skipped by the previous lineup", () => {
  const players = ["a", "b", "c", "d", "e", "f"].map((id) => player(id, Gender.MALE, 2));
  const first = suggestMatch(players, MatchmakingMode.BALANCED, history);
  assert.ok(first);
  const firstIds = new Set([...first.teamA, ...first.teamB].map((item) => item.id));
  const skippedIds = players.filter((item) => !firstIds.has(item.id)).map((item) => item.id);

  const next = suggestMatch(players, MatchmakingMode.BALANCED, history, [first.key]);
  assert.ok(next);
  const nextIds = new Set([...next.teamA, ...next.teamB].map((item) => item.id));
  assert.equal(skippedIds.every((id) => nextIds.has(id)), true);
  assert.equal((next.explanation.fairness as { previouslySkippedCount: number }).previouslySkippedCount, skippedIds.length);
});

test("pending late penalties disable skipped-player priority for balanced suggestions", () => {
  const players = ["a", "b", "c", "d", "e", "f"].map((id) => player(id, Gender.MALE, 2));
  players[5]!.latePenaltyState = "PENDING";
  const result = suggestMatch(players, MatchmakingMode.BALANCED, history, ["a,b|c,d"]);
  assert.ok(result);
  assert.deepEqual([...result.teamA, ...result.teamB].map((item) => item.id).sort(), ["a", "b", "c", "d"]);
  assert.equal((result.explanation.fairness as { previouslySkippedCount: number }).previouslySkippedCount, 0);
});

test("balanced mode rejects distant player levels even when team totals can tie", () => {
  assert.equal(suggestMatch([
    player("a", Gender.MALE, 1),
    player("b", Gender.MALE, 1),
    player("c", Gender.MALE, 3),
    player("d", Gender.MALE, 3),
  ], MatchmakingMode.BALANCED, history), null);
  assert.equal(suggestMatch([
    player("a", Gender.MALE, 1),
    player("b", Gender.MALE, 1),
    player("c", Gender.MALE, 5),
    player("d", Gender.MALE, 5),
  ], MatchmakingMode.BALANCED, history), null);
  assert.ok(suggestMatch([
    player("a", Gender.MALE, 1),
    player("b", Gender.MALE, 1),
    player("c", Gender.MALE, 3),
    player("d", Gender.MALE, 3),
  ], MatchmakingMode.OPEN, history));
});

test("balanced eligibility is evaluated before late penalties and exclusions", () => {
  const players = [
    player("a", Gender.MALE, 1),
    player("b", Gender.MALE, 1),
    player("c", Gender.MALE, 1),
    player("d", Gender.MALE, 4),
    player("e", Gender.MALE, 2),
  ];
  players[4]!.latePenaltyState = "PENDING";
  const result = suggestMatch(players, MatchmakingMode.BALANCED, history);
  assert.ok(result);
  assert.equal([...result.teamA, ...result.teamB].some((item) => item.id === "e"), true);
  assert.ok(result.difference <= 1);
  assert.equal(suggestMatch([
    player("a", Gender.MALE, 2),
    player("b", Gender.MALE, 2),
    player("c", Gender.MALE, 3),
    player("d", Gender.MALE, 3),
  ], MatchmakingMode.BALANCED, history, ["a,c|b,d", "a,d|b,c"]), null);
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
    queueMasterId: "account-1",
    source: "MANUAL",
    currentRevisionId: "revision-2",
    startedAt,
    completedAt,
    participants: [
      { queuePlayerId: "a", team: "A", teamSlot: 1, queuePlayer: { playerId: "player-a", displayNameSnapshot: "Alice", genderSnapshot: Gender.FEMALE, skillLevelSnapshot: "BEGINNER" } },
      { queuePlayerId: "b", team: "B", teamSlot: 1, queuePlayer: { playerId: "player-b", displayNameSnapshot: "Bob", genderSnapshot: Gender.MALE, skillLevelSnapshot: "INTERMEDIATE" } },
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

test("history formatting preserves a deleted court snapshot", () => {
  const result = historyMatchView({
    id: "match-deleted-court",
    source: "MANUAL",
    court: null,
    courtIdSnapshot: "court-old",
    courtNameSnapshot: "Court North",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: new Date("2026-01-01T00:02:00Z"),
    participants: [],
    scoreRevisions: [],
  });
  assert.deepEqual(result.court, { id: "court-old", name: "Court North" });
});

test("history frequent-player ties resolve by display name", () => {
  const result = chooseFrequentParticipant(new Map([
    ["b", { queuePlayerId: "b", displayName: "Zoe", count: 2 }],
    ["a", { queuePlayerId: "a", displayName: "Amy", count: 2 }],
  ]));
  assert.equal(result?.displayName, "Amy");
});
