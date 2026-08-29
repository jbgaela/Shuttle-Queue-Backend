import { Gender, MatchmakingMode, QueuePlayerStatus } from "@prisma/client";
import { MATCHMAKING_ALGORITHM, LONE_FEMALE_SKILL_LEVELS, isMixedDoublesGroup as isDomainMixedDoublesGroup, isStandardMixedDoublesLineup as isDomainStandardMixedDoublesLineup, suggestMatch as suggestDomainMatch, undefeatedChallengePlayers as domainUndefeatedChallengePlayers, validateMixedDoublesLineup as validateDomainMixedDoublesLineup, type MatchHistory as DomainMatchHistory, type MatchPlayer as DomainMatchPlayer, type MatchmakingMode as DomainMatchmakingMode } from "@shuttle-queue/domain";

export type MatchPlayer = {
  id: string;
  displayName: string;
  gender: Gender;
  skillWeight: number;
  skillLevel: string;
  status: QueuePlayerStatus;
  gamesPlayed: number;
  wins?: number;
  losses?: number;
  queueEnteredAt: Date | null;
  lastMatchEndedAt: Date | null;
  manualPriority: number;
  latePenaltyState?: "PENDING" | "SERVED" | "WAIVED" | null;
  latePenaltyAppliedAt?: Date | null;
};

type PairMap = Map<string, Map<string, number>>;
export type MatchHistory = { partners: PairMap; opponents: PairMap; quartets: Map<string, number>; encounters?: PairMap; recentPartners?: PairMap; recentOpponents?: PairMap; recentEncounters?: PairMap; recentQuartets?: Map<string, number> };
export type MatchmakingOptions = { strengthGap?: 1 | 2 | 3; minimumRestMinutes?: number; now?: Date };
export type Suggestion = { mode: MatchmakingMode; teamA: MatchPlayer[]; teamB: MatchPlayer[]; teamATotal: number; teamBTotal: number; difference: number; key: string; explanation: Record<string, unknown> };

export { MATCHMAKING_ALGORITHM };
const isQualifiedLoneFemaleGroup = (group: MatchPlayer[]) => group.length === 4 && group.filter((player) => player.gender === Gender.FEMALE).length === 1 && group.filter((player) => player.gender === Gender.MALE).length === 3 && group.some((player) => player.gender === Gender.FEMALE && LONE_FEMALE_SKILL_LEVELS.some((level) => level === player.skillLevel));
export const loneFemalePolicy = (teamA: MatchPlayer[], teamB: MatchPlayer[], mixedDoublesFallback = false) => { const group = [...teamA, ...teamB]; const qualifyingFemale = isQualifiedLoneFemaleGroup(group) ? group.find((player) => player.gender === Gender.FEMALE) : undefined; return { eligibleSkillLevels: ["INTERMEDIATE", "UPPER_INTERMEDIATE", "ADVANCED"], qualifyingFemaleId: qualifyingFemale?.id ?? null, applied: Boolean(qualifyingFemale), mixedDoublesFallback: Boolean(qualifyingFemale && mixedDoublesFallback) }; };
export function undefeatedChallengePlayers(players: MatchPlayer[]) {
  const originalById = new Map(players.map((player) => [player.id, player]));
  const input: DomainMatchPlayer[] = players.map((player) => ({ id: player.id, displayName: player.displayName, gender: player.gender, skillWeight: player.skillWeight, skillLevel: player.skillLevel as DomainMatchPlayer["skillLevel"], status: player.status as DomainMatchPlayer["status"], gamesPlayed: player.gamesPlayed, wins: player.wins, losses: player.losses, queueEnteredAt: player.queueEnteredAt?.toISOString() ?? null, lastMatchEndedAt: player.lastMatchEndedAt?.toISOString() ?? null, manualPriority: player.manualPriority, latePenaltyState: player.latePenaltyState }));
  return domainUndefeatedChallengePlayers(input).flatMap(({ player, rank }) => {
    const original = originalById.get(player.id);
    return original ? [{ player: original, rank }] : [];
  });
}
export const isProhibitedGeneratedGenderMatch = (teamA: MatchPlayer[], teamB: MatchPlayer[]) =>
  teamA.length === 2 && teamB.length === 2
  && ((teamA.every((player) => player.gender === Gender.FEMALE) && teamB.every((player) => player.gender === Gender.MALE))
    || (teamA.every((player) => player.gender === Gender.MALE) && teamB.every((player) => player.gender === Gender.FEMALE)));

const isAllowedNewbiePartner = (player: MatchPlayer) => player.skillLevel === "BEGINNER" || player.skillLevel === "UPPER_BEGINNER";
export const isProhibitedGeneratedNewbieMatch = (teamA: MatchPlayer[], teamB: MatchPlayer[]) => {
  if (teamA.length !== 2 || teamB.length !== 2) return false;
  return [teamA, teamB].some((team) => team.some((player) => {
    if (player.skillLevel !== "NEWBIE") return false;
    const partner = team.find((candidate) => candidate.id !== player.id);
    return !partner || !isAllowedNewbiePartner(partner);
  }));
};
export const validateBalancedLineup = (teamA: MatchPlayer[], teamB: MatchPlayer[], strengthGap: number) => {
  const group = [...teamA, ...teamB];
  if (![1, 2].includes(teamA.length) || teamA.length !== teamB.length || new Set(group.map((player) => player.id)).size !== group.length) return "Choose unique players with equal team sizes for singles or doubles.";
  const spread = Math.max(...group.map((player) => player.skillWeight)) - Math.min(...group.map((player) => player.skillWeight));
  if (spread > strengthGap) return `Handicap matchups require a player strength spread of at most ${strengthGap}.`;
  const teamDifference = Math.abs(teamA.reduce((sum, player) => sum + player.skillWeight, 0) - teamB.reduce((sum, player) => sum + player.skillWeight, 0));
  if (teamDifference !== strengthGap) return `Handicap matchups require team strength totals to differ by exactly ${strengthGap}.`;
  return null;
};

const toDomainPlayer = (player: MatchPlayer): DomainMatchPlayer => ({
  id: player.id,
  displayName: player.displayName,
  gender: player.gender,
  skillWeight: player.skillWeight,
  skillLevel: player.skillLevel as DomainMatchPlayer["skillLevel"],
  status: player.status as DomainMatchPlayer["status"],
  gamesPlayed: player.gamesPlayed,
  wins: player.wins,
  losses: player.losses,
  queueEnteredAt: player.queueEnteredAt?.toISOString() ?? null,
  lastMatchEndedAt: player.lastMatchEndedAt?.toISOString() ?? null,
  manualPriority: player.manualPriority,
  latePenaltyState: player.latePenaltyState,
});

/** The deploy-local domain package is the single source of truth for matchmaking. */
export function suggestMatch(players: MatchPlayer[], mode: MatchmakingMode, history: MatchHistory, excludedKeys: string[] = [], options: MatchmakingOptions = {}): Suggestion | null {
  const originalById = new Map(players.map((player) => [player.id, player]));
  const result = suggestDomainMatch(players.map(toDomainPlayer), mode as DomainMatchmakingMode, history as unknown as DomainMatchHistory, excludedKeys, options);
  if (!result) return null;
  const toLocal = (player: DomainMatchPlayer): MatchPlayer => {
    const original = originalById.get(player.id);
    if (!original) throw new Error("Matchmaking suggestion referenced an unknown player.");
    return original;
  };
  return {
    mode,
    teamA: result.teamA.map(toLocal),
    teamB: result.teamB.map(toLocal),
    teamATotal: result.teamATotal,
    teamBTotal: result.teamBTotal,
    difference: result.difference,
    key: result.key,
    explanation: result.explanation,
  };
}

const toDomainLineup = (players: MatchPlayer[]): DomainMatchPlayer[] => players.map(toDomainPlayer);
export const isMixedDoublesGroup = (group: MatchPlayer[]) => isDomainMixedDoublesGroup(toDomainLineup(group));
export const isStandardMixedDoublesLineup = (teamA: MatchPlayer[], teamB: MatchPlayer[]) => isDomainStandardMixedDoublesLineup(toDomainLineup(teamA), toDomainLineup(teamB));
export const validateMixedDoublesLineup = (teamA: MatchPlayer[], teamB: MatchPlayer[]) => validateDomainMixedDoublesLineup(toDomainLineup(teamA), toDomainLineup(teamB));
