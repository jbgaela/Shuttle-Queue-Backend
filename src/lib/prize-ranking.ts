import { prizeRankingRows, PRIZE_RANKING_METHOD, type PrizeRankingInput } from "@shuttle-queue/domain";

export { PRIZE_RANKING_METHOD };

export type RankingRecord = PrizeRankingInput & { displayNameSnapshot?: string };

export function rankRecords<T extends RankingRecord>(rows: T[], sessionStartedAt: Date | string) {
  return prizeRankingRows(rows.map((row) => ({ ...row, displayName: row.displayName ?? row.displayNameSnapshot ?? "" })), new Date(sessionStartedAt).toISOString());
}

export function rankingStats(row: { matchesPlayed: number; wins: number; pointsFor: number; pointsAgainst: number }) {
  return {
    winRateBasisPoints: row.matchesPlayed > 0 ? Math.floor((row.wins * 10000) / row.matchesPlayed) : 0,
    pointDifferential: row.pointsFor - row.pointsAgainst,
  };
}
