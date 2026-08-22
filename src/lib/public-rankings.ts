import { createHash } from "node:crypto";
import type { CloudSnapshotV2 } from "@shuttle-queue/domain";
import { normalizeName } from "./normalize.js";

export const PUBLIC_RANKING_SNAPSHOT_VERSION = 2;
export const PUBLIC_RANKING_MATCH_LIMIT = 1000;

export type PublicRankingRow = {
  rank: number;
  playerKey: string;
  player: string;
  matchesPlayed: number;
  wins: number;
  losses: number;
  winRateBasisPoints: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDifferential: number;
};

export type PublicRankingMatch = {
  matchKey: string;
  completedAt: string | null;
  winnerTeam: "A" | "B" | null;
  participants: Array<{ playerKey: string; player: string; team: "A" | "B"; teamSlot: number }>;
  games: Array<{ gameNumber: number; teamAScore: number; teamBScore: number; winnerTeam: "A" | "B" }>;
};

export type PublicRankingSnapshot = {
  schemaVersion: typeof PUBLIC_RANKING_SNAPSHOT_VERSION;
  capturedAt: string;
  rankings: PublicRankingRow[];
  matches: PublicRankingMatch[];
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

export function publicPlayerKey(publicationId: string, queuePlayerId: string) {
  return publicKey(publicationId, queuePlayerId);
}

function publicMatchKey(publicationId: string, matchId: string) {
  return publicKey(publicationId, matchId);
}

function publicRankingRow(row: RankingPlayer, index: number, publicationId: string): PublicRankingRow {
  return {
    rank: index + 1,
    playerKey: publicPlayerKey(publicationId, row.id),
    player: row.displayNameSnapshot,
    matchesPlayed: row.matchesPlayed,
    wins: row.wins,
    losses: row.losses,
    winRateBasisPoints: row.matchesPlayed ? Math.floor((row.wins * 10000) / row.matchesPlayed) : 0,
    pointsFor: row.pointsFor,
    pointsAgainst: row.pointsAgainst,
    pointDifferential: row.pointsFor - row.pointsAgainst,
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

export function publicRankingSnapshotFromRecords({ publicationId, capturedAt, rows, matches }: { publicationId: string; capturedAt: Date; rows: any[]; matches: any[] }): PublicRankingSnapshot {
  return {
    schemaVersion: PUBLIC_RANKING_SNAPSHOT_VERSION,
    capturedAt: capturedAt.toISOString(),
    rankings: rows.map((row, index) => publicRankingRow(row, index, publicationId)),
    matches: matches
      .map((match) => publicMatchFromRecord(match, publicationId))
      .filter((match): match is PublicRankingMatch => Boolean(match))
      .sort((left, right) => (right.completedAt ?? "").localeCompare(left.completedAt ?? "") || left.matchKey.localeCompare(right.matchKey))
      .slice(0, PUBLIC_RANKING_MATCH_LIMIT),
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
  return publicRankingSnapshotFromRecords({
    publicationId,
    capturedAt,
    rows: [...snapshot.queuePlayers].sort((left, right) => right.wins - left.wins || right.matchesPlayed - left.matchesPlayed || normalizeName(left.displayName).localeCompare(normalizeName(right.displayName))).map((player) => ({ ...player, displayNameSnapshot: player.displayName })),
    matches: (snapshot.matches ?? []).filter((match) => match.status === "COMPLETED").map((match) => cloudMatchRecord(match, names)),
  });
}

export function isPublicRankingSnapshot(value: unknown): value is PublicRankingSnapshot {
  return Boolean(value && typeof value === "object" && (value as { schemaVersion?: unknown }).schemaVersion === PUBLIC_RANKING_SNAPSHOT_VERSION && Array.isArray((value as { rankings?: unknown }).rankings) && Array.isArray((value as { matches?: unknown }).matches));
}

export function publicHistoryFromSnapshot(snapshot: PublicRankingSnapshot, playerKey: string) {
  const player = snapshot.rankings.find((row) => row.playerKey === playerKey);
  if (!player) return null;
  return {
    player: { playerKey, player: player.player },
    matches: snapshot.matches.filter((match) => match.participants.some((participant) => participant.playerKey === playerKey)).map((match) => ({
      matchKey: match.matchKey,
      completedAt: match.completedAt,
      winnerTeam: match.winnerTeam,
      result: match.winnerTeam && match.participants.some((participant) => participant.playerKey === playerKey && participant.team === match.winnerTeam) ? "WIN" : "LOSS",
      teamA: match.participants.filter((participant) => participant.team === "A").sort((left, right) => left.teamSlot - right.teamSlot).map((participant) => participant.player),
      teamB: match.participants.filter((participant) => participant.team === "B").sort((left, right) => left.teamSlot - right.teamSlot).map((participant) => participant.player),
      games: match.games,
    })),
  };
}

export function activePublicRankingWhere() {
  return {
    enabled: true,
    OR: [{ revokedAt: null }, { revokedAt: { isSet: false } }],
  };
}
