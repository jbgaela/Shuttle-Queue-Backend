import { createHash } from "node:crypto";
import type { CloudSnapshotV2 } from "@shuttle-queue/domain";
import { PRIZE_RANKING_METHOD, rankRecords } from "./prize-ranking.js";
import { historyDurationSeconds } from "./history.js";

export const PUBLIC_RANKING_SNAPSHOT_VERSION = 4;
export const PUBLIC_RANKING_MATCH_LIMIT = 1000;
const DEFAULT_RANKING_SESSION_STARTED_AT = new Date(0).toISOString();

export type PublicRankingRow = {
  rank: number | null;
  playerKey: string;
  player: string;
  matchesPlayed: number;
  wins: number;
  losses: number;
  winRateBasisPoints: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDifferential: number;
  eligible: boolean;
  gamesNeeded: number;
  rankingScoreBasisPoints: number | null;
  pointPercentageBasisPoints: number | null;
  isPrizePosition: boolean;
  seededDrawUsed: boolean;
};

export type PublicRankingMatch = {
  matchKey: string;
  startedAt?: string | null;
  completedAt: string | null;
  winnerTeam: "A" | "B" | null;
  participants: Array<{ playerKey: string; player: string; team: "A" | "B"; teamSlot: number }>;
  games: Array<{ gameNumber: number; teamAScore: number; teamBScore: number; winnerTeam: "A" | "B" }>;
};

export type PublicRankingSnapshot = {
  schemaVersion: 2 | 3 | typeof PUBLIC_RANKING_SNAPSHOT_VERSION;
  capturedAt: string;
  firstMatchStartedAt?: string | null;
  rankings: PublicRankingRow[];
  matches: PublicRankingMatch[];
  rankingMethod: typeof PRIZE_RANKING_METHOD;
};

export type PublicRankingPlayerHistoryStats = {
  averageDurationSeconds: number | null;
  mostPlayedPartner: { displayName: string; count: number } | null;
  mostPlayedOpponent: { displayName: string; count: number } | null;
};

type RankingPlayer = {
  id: string;
  displayNameSnapshot: string;
  matchesPlayed: number;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
};

function publicKey(publicationId: string, entityId: string) {
  return createHash("sha256").update(`${publicationId}:${entityId}`).digest("base64url");
}

export function earliestMatchStartedAt(matches: Array<{ startedAt?: Date | string | null }>): string | null {
  let earliest: number | null = null;
  for (const match of matches) {
    if (match.startedAt === null || match.startedAt === undefined) continue;
    const timestamp = match.startedAt instanceof Date ? match.startedAt.getTime() : new Date(match.startedAt).getTime();
    if (!Number.isFinite(timestamp) || (earliest !== null && timestamp >= earliest)) continue;
    earliest = timestamp;
  }
  return earliest === null ? null : new Date(earliest).toISOString();
}

export function publicPlayerKey(publicationId: string, queuePlayerId: string) {
  return publicKey(publicationId, queuePlayerId);
}

function publicMatchKey(publicationId: string, matchId: string) {
  return publicKey(publicationId, matchId);
}

function publicRankingRow(row: RankingPlayer & { rank?: number | null; eligible?: boolean; gamesNeeded?: number; rankingScoreBasisPoints?: number | null; pointPercentageBasisPoints?: number | null; isPrizePosition?: boolean; seededDrawUsed?: boolean }, publicationId: string): PublicRankingRow {
  return {
    rank: row.rank ?? null,
    playerKey: publicPlayerKey(publicationId, row.id),
    player: row.displayNameSnapshot,
    matchesPlayed: row.matchesPlayed,
    wins: row.wins,
    losses: row.losses,
    winRateBasisPoints: row.matchesPlayed ? Math.floor((row.wins * 10000) / row.matchesPlayed) : 0,
    pointsFor: row.pointsFor,
    pointsAgainst: row.pointsAgainst,
    pointDifferential: row.pointsFor - row.pointsAgainst,
    eligible: row.eligible ?? false,
    gamesNeeded: row.gamesNeeded ?? 0,
    rankingScoreBasisPoints: row.rankingScoreBasisPoints ?? null,
    pointPercentageBasisPoints: row.pointPercentageBasisPoints ?? null,
    isPrizePosition: row.isPrizePosition ?? false,
    seededDrawUsed: row.seededDrawUsed ?? false,
  };
}

function currentRevision(match: any) {
  return (match.scoreRevisions ?? []).find((revision: any) => revision.id === match.currentRevisionId);
}

export function publicMatchFromRecord(match: any, publicationId: string): PublicRankingMatch | null {
  if (match.status !== "COMPLETED") return null;
  const revision = currentRevision(match);
  return {
    matchKey: publicMatchKey(publicationId, String(match.id)),
    startedAt: match.startedAt instanceof Date ? match.startedAt.toISOString() : match.startedAt ?? null,
    completedAt: match.completedAt instanceof Date ? match.completedAt.toISOString() : match.completedAt ?? null,
    winnerTeam: match.winnerTeam ?? revision?.winnerTeam ?? null,
    participants: (match.participants ?? []).map((participant: any) => ({
      playerKey: publicPlayerKey(publicationId, String(participant.queuePlayerId)),
      player: participant.queuePlayer?.displayNameSnapshot ?? participant.displayName ?? "Player unavailable",
      team: participant.team,
      teamSlot: participant.teamSlot,
    })),
    games: (revision?.games ?? []).slice().sort((left: any, right: any) => left.gameNumber - right.gameNumber).map((game: any) => ({
      gameNumber: game.gameNumber,
      teamAScore: game.teamAScore,
      teamBScore: game.teamBScore,
      winnerTeam: game.winnerTeam,
    })),
  };
}

export function publicRankingSnapshotFromRecords({ publicationId, capturedAt, rows, matches, firstMatchStartedAt, sessionStartedAt }: { publicationId: string; capturedAt: Date; rows: any[]; matches: any[]; firstMatchStartedAt?: Date | string | null; sessionStartedAt?: Date | string | null }): PublicRankingSnapshot {
  const rankedRows = rankRecords(rows.map((row) => ({ ...row, displayName: row.displayName ?? row.displayNameSnapshot ?? row.player ?? "" })), sessionStartedAt ?? firstMatchStartedAt ?? DEFAULT_RANKING_SESSION_STARTED_AT);
  return {
    schemaVersion: PUBLIC_RANKING_SNAPSHOT_VERSION,
    capturedAt: capturedAt.toISOString(),
    firstMatchStartedAt: firstMatchStartedAt === undefined ? earliestMatchStartedAt(matches) : earliestMatchStartedAt([{ startedAt: firstMatchStartedAt }]),
    rankings: rankedRows.map((row) => publicRankingRow({ ...row, displayNameSnapshot: row.displayName }, publicationId)),
    matches: matches
      .map((match) => publicMatchFromRecord(match, publicationId))
      .filter((match): match is PublicRankingMatch => Boolean(match))
      .sort((left, right) => (right.completedAt ?? "").localeCompare(left.completedAt ?? "") || left.matchKey.localeCompare(right.matchKey))
      .slice(0, PUBLIC_RANKING_MATCH_LIMIT),
    rankingMethod: PRIZE_RANKING_METHOD,
  };
}

function cloudMatchRecord(match: CloudSnapshotV2["matches"][number], names: Map<string, string>) {
  return {
    ...match,
    participants: match.participants.map((participant) => ({ ...participant, queuePlayer: { displayNameSnapshot: names.get(participant.queuePlayerId) ?? "Player unavailable" } })),
  };
}

export function publicRankingSnapshotFromCloudSnapshot(snapshot: CloudSnapshotV2, publicationId: string, capturedAt: Date): PublicRankingSnapshot {
  const names = new Map(snapshot.queuePlayers.map((player) => [player.id, player.displayName]));
  const allMatches = snapshot.matches ?? [];
  return publicRankingSnapshotFromRecords({
    publicationId,
    capturedAt,
    rows: snapshot.queuePlayers.map((player) => ({ ...player, displayNameSnapshot: player.displayName })),
    sessionStartedAt: snapshot.workspace?.startedAt,
    firstMatchStartedAt: earliestMatchStartedAt(allMatches),
    matches: allMatches.filter((match) => match.status === "COMPLETED").map((match) => cloudMatchRecord(match, names)),
  });
}

export function isPublicRankingSnapshot(value: unknown): value is PublicRankingSnapshot {
  return Boolean(value && typeof value === "object" && [2, 3, PUBLIC_RANKING_SNAPSHOT_VERSION].includes((value as { schemaVersion?: unknown }).schemaVersion as number) && Array.isArray((value as { rankings?: unknown }).rankings) && Array.isArray((value as { matches?: unknown }).matches));
}

export function recalculatePublicRankingRows(rows: Array<Record<string, any>>, sessionStartedAt: Date | string) {
  return rankRecords(rows.map((row) => ({ id: String(row.playerKey ?? row.id ?? row.player), displayName: String(row.player ?? row.displayName ?? ""), matchesPlayed: Number(row.matchesPlayed) || 0, wins: Number(row.wins) || 0, losses: Number(row.losses) || 0, pointsFor: Number(row.pointsFor) || 0, pointsAgainst: Number(row.pointsAgainst) || 0 })), sessionStartedAt).map((row) => ({ rank: row.rank, playerKey: rows.find((candidate) => String(candidate.playerKey ?? candidate.id ?? candidate.player) === row.id)?.playerKey ?? row.id, player: row.displayName, matchesPlayed: row.matchesPlayed, wins: row.wins, losses: row.losses, winRateBasisPoints: row.matchesPlayed ? Math.floor((row.wins * 10000) / row.matchesPlayed) : 0, pointsFor: row.pointsFor, pointsAgainst: row.pointsAgainst, pointDifferential: row.pointsFor - row.pointsAgainst, eligible: row.eligible, gamesNeeded: row.gamesNeeded, rankingScoreBasisPoints: row.rankingScoreBasisPoints, pointPercentageBasisPoints: row.pointPercentageBasisPoints, isPrizePosition: row.isPrizePosition, seededDrawUsed: row.seededDrawUsed }));
}

function publicHistoryStats(matches: PublicRankingMatch[], playerKey: string): PublicRankingPlayerHistoryStats {
  const durations: number[] = [];
  const partners = new Map<string, { displayName: string; count: number }>();
  const opponents = new Map<string, { displayName: string; count: number }>();
  const increment = (counts: Map<string, { displayName: string; count: number }>, participant: PublicRankingMatch["participants"][number]) => {
    const current = counts.get(participant.playerKey);
    counts.set(participant.playerKey, { displayName: participant.player, count: (current?.count ?? 0) + 1 });
  };
  for (const match of matches) {
    const selected = match.participants.find((participant) => participant.playerKey === playerKey);
    if (!selected) continue;
    const duration = historyDurationSeconds(match);
    if (duration !== null && Number.isFinite(duration)) durations.push(duration);
    for (const participant of match.participants) {
      if (participant.playerKey === playerKey) continue;
      increment(participant.team === selected.team ? partners : opponents, participant);
    }
  }
  const choose = (counts: Map<string, { displayName: string; count: number }>) => [...counts.entries()].sort((left, right) => right[1].count - left[1].count || left[1].displayName.localeCompare(right[1].displayName) || left[0].localeCompare(right[0]))[0]?.[1] ?? null;
  return {
    averageDurationSeconds: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    mostPlayedPartner: choose(partners),
    mostPlayedOpponent: choose(opponents),
  };
}

function publicHistoryMatch(match: PublicRankingMatch, playerKey: string) {
  return {
    matchKey: match.matchKey,
    completedAt: match.completedAt,
    winnerTeam: match.winnerTeam,
    result: match.winnerTeam && match.participants.some((participant) => participant.playerKey === playerKey && participant.team === match.winnerTeam) ? "WIN" : "LOSS",
    teamA: match.participants.filter((participant) => participant.team === "A").sort((left, right) => left.teamSlot - right.teamSlot).map((participant) => participant.player),
    teamB: match.participants.filter((participant) => participant.team === "B").sort((left, right) => left.teamSlot - right.teamSlot).map((participant) => participant.player),
    games: match.games,
  };
}

export function publicHistoryFromMatches(player: { playerKey: string; player: string }, matches: PublicRankingMatch[]) {
  const playerMatches = matches.filter((match) => match.participants.some((participant) => participant.playerKey === player.playerKey));
  return {
    player,
    stats: publicHistoryStats(playerMatches, player.playerKey),
    matches: playerMatches.map((match) => publicHistoryMatch(match, player.playerKey)),
  };
}

export function publicHistoryFromSnapshot(snapshot: PublicRankingSnapshot, playerKey: string) {
  const player = snapshot.rankings.find((row) => row.playerKey === playerKey);
  if (!player) return null;
  return publicHistoryFromMatches({ playerKey, player: player.player }, snapshot.matches);
}

export function activePublicRankingWhere() {
  return {
    enabled: true,
    OR: [{ revokedAt: null }, { revokedAt: { isSet: false } }],
  };
}
