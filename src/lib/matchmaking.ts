import { Gender, MatchmakingMode, QueuePlayerStatus } from "@prisma/client";
import { LONE_FEMALE_SKILL_LEVELS, suggestMatch as suggestDomainMatch, undefeatedChallengePlayers as domainUndefeatedChallengePlayers, type MatchHistory as DomainMatchHistory, type MatchPlayer as DomainMatchPlayer } from "@shuttle-queue/domain";

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

const DEFAULT_BALANCED_STRENGTH_GAP = 1;
export const MATCHMAKING_ALGORITHM = "v7-newbie-partner-policy";
const isQualifiedLoneFemaleGroup = (group: MatchPlayer[]) => group.length === 4 && group.filter((player) => player.gender === Gender.FEMALE).length === 1 && group.filter((player) => player.gender === Gender.MALE).length === 3 && group.some((player) => player.gender === Gender.FEMALE && LONE_FEMALE_SKILL_LEVELS.some((level) => level === player.skillLevel));
export const loneFemalePolicy = (teamA: MatchPlayer[], teamB: MatchPlayer[], mixedDoublesFallback = false) => { const group = [...teamA, ...teamB]; const qualifyingFemale = isQualifiedLoneFemaleGroup(group) ? group.find((player) => player.gender === Gender.FEMALE) : undefined; return { eligibleSkillLevels: ["INTERMEDIATE", "UPPER_INTERMEDIATE", "ADVANCED"], qualifyingFemaleId: qualifyingFemale?.id ?? null, applied: Boolean(qualifyingFemale), mixedDoublesFallback: Boolean(qualifyingFemale && mixedDoublesFallback) }; };
const count = (map: PairMap | undefined, a: string, b: string) => map?.get(a)?.get(b) ?? 0;
const symmetricCount = (map: PairMap | undefined, a: string, b: string) => Math.max(count(map, a, b), count(map, b, a));
const quartetKey = (players: MatchPlayer[]) => players.map((player) => player.id).sort().join(":");
const sortedNumbers = (values: number[]) => [...values].sort((a, b) => a - b);
const sortedTimes = (players: MatchPlayer[]) => players.map((player) => player.queueEnteredAt?.getTime() ?? Number.MAX_SAFE_INTEGER).sort((a, b) => a - b);
const compareArrays = (a: number[], b: number[]) => { for (let index = 0; index < Math.max(a.length, b.length); index += 1) { const left = a[index] ?? 0; const right = b[index] ?? 0; if (left !== right) return left - right; } return 0; };
const compareCandidateKey = (a: (number[] | number | string)[], b: (number[] | number | string)[]) => { for (let index = 0; index < a.length; index += 1) { const left = a[index]; const right = b[index]; if (Array.isArray(left) && Array.isArray(right)) { const result = compareArrays(left, right); if (result !== 0) return result; } else if (typeof left === "string" && typeof right === "string") { const result = left.localeCompare(right); if (result !== 0) return result; } else if (typeof left === "number" && typeof right === "number" && left !== right) return left - right; } return 0; };
const forEachCombination = <T,>(items: T[], size: number, callback: (selected: T[]) => void) => { const walk = (start: number, selected: T[]) => { if (selected.length === size) { callback([...selected]); return; } for (let index = start; index <= items.length - (size - selected.length); index += 1) { selected.push(items[index]!); walk(index + 1, selected); selected.pop(); } }; walk(0, []); };
const partitions = (players: MatchPlayer[]) => { const [first, second, third, fourth] = players; return [[[first, second], [third, fourth]], [[first, third], [second, fourth]], [[first, fourth], [second, third]]] as [MatchPlayer[], MatchPlayer[]][]; };
const restReadyAt = (lastMatchEndedAt: Date | null, minimumRestMinutes: number, now: number) => !lastMatchEndedAt || minimumRestMinutes <= 0 ? now : lastMatchEndedAt.getTime() + minimumRestMinutes * 60_000;

function encounterCount(history: MatchHistory, a: string, b: string, recent: boolean) {
  const direct = recent ? history.recentEncounters : history.encounters;
  const directCount = symmetricCount(direct, a, b);
  if (directCount > 0) return directCount;
  return Math.max(symmetricCount(recent ? history.recentPartners : history.partners, a, b), symmetricCount(recent ? history.recentOpponents : history.opponents, a, b));
}
function partnerCount(history: MatchHistory, a: string, b: string, recent: boolean) { return symmetricCount(recent ? history.recentPartners : history.partners, a, b); }
function pairStats(history: MatchHistory, players: MatchPlayer[], recent: boolean) { const values: number[] = []; for (let left = 0; left < players.length; left += 1) for (let right = left + 1; right < players.length; right += 1) values.push(encounterCount(history, players[left]!.id, players[right]!.id, recent)); return { repeatedPairs: values.filter((value) => value > 0).length, total: values.reduce((sum, value) => sum + value, 0) }; }
function partnerRepeats(history: MatchHistory, team: MatchPlayer[], recent: boolean) { return partnerCount(history, team[0]!.id, team[1]!.id, recent); }
function skillMix(team: MatchPlayer[]) { return Math.abs(team[0]!.skillWeight - team[1]!.skillWeight); }

function suggestDomainChallenge(players: MatchPlayer[], history: MatchHistory, excludedKeys: string[], options: MatchmakingOptions): Suggestion | null {
  const originalById = new Map(players.map((player) => [player.id, player]));
  const input: DomainMatchPlayer[] = players.map((player) => ({ id: player.id, displayName: player.displayName, gender: player.gender, skillWeight: player.skillWeight, skillLevel: player.skillLevel as DomainMatchPlayer["skillLevel"], status: player.status as DomainMatchPlayer["status"], gamesPlayed: player.gamesPlayed, wins: player.wins, losses: player.losses, queueEnteredAt: player.queueEnteredAt?.toISOString() ?? null, lastMatchEndedAt: player.lastMatchEndedAt?.toISOString() ?? null, manualPriority: player.manualPriority, latePenaltyState: player.latePenaltyState }));
  const result = suggestDomainMatch(input, "UNDEFEATED_CHALLENGE", history as unknown as DomainMatchHistory, excludedKeys, { minimumRestMinutes: options.minimumRestMinutes, now: options.now });
  if (!result) return null;
  const toLocal = (player: DomainMatchPlayer): MatchPlayer => {
    const original = originalById.get(player.id);
    if (!original) throw new Error("Challenge suggestion referenced an unknown player.");
    return original;
  };
  return { mode: MatchmakingMode.UNDEFEATED_CHALLENGE, teamA: result.teamA.map(toLocal), teamB: result.teamB.map(toLocal), teamATotal: result.teamATotal, teamBTotal: result.teamBTotal, difference: result.difference, key: result.key, explanation: result.explanation };
}

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
const hasNewbieCompatiblePartition = (group: MatchPlayer[]) => partitions(group).some(([teamA, teamB]) => !isProhibitedGeneratedNewbieMatch(teamA, teamB));

export const validateBalancedLineup = (teamA: MatchPlayer[], teamB: MatchPlayer[], strengthGap: number) => {
  const group = [...teamA, ...teamB];
  if (![1, 2].includes(teamA.length) || teamA.length !== teamB.length || new Set(group.map((player) => player.id)).size !== group.length) return "Choose unique players with equal team sizes for singles or doubles.";
  const spread = Math.max(...group.map((player) => player.skillWeight)) - Math.min(...group.map((player) => player.skillWeight));
  if (spread > strengthGap) return `Handicap matchups require a player strength spread of at most ${strengthGap}.`;
  const teamDifference = Math.abs(teamA.reduce((sum, player) => sum + player.skillWeight, 0) - teamB.reduce((sum, player) => sum + player.skillWeight, 0));
  if (teamDifference !== strengthGap) return `Handicap matchups require team strength totals to differ by exactly ${strengthGap}.`;
  return null;
};

export function suggestMatch(players: MatchPlayer[], mode: MatchmakingMode, history: MatchHistory, excludedKeys: string[] = [], options: MatchmakingOptions = {}): Suggestion | null {
  if (mode === MatchmakingMode.UNDEFEATED_CHALLENGE) return suggestDomainChallenge(players, history, excludedKeys, options);
  const now = (options.now ?? new Date()).getTime();
  const minimumRestMinutes = Math.max(0, options.minimumRestMinutes ?? 0);
  const strengthGap = mode === MatchmakingMode.BALANCED ? options.strengthGap ?? DEFAULT_BALANCED_STRENGTH_GAP : undefined;
  const eligible = players.filter((player) => player.status === QueuePlayerStatus.WAITING && player.queueEnteredAt && restReadyAt(player.lastMatchEndedAt, minimumRestMinutes, now) <= now);
  if (eligible.length < 4) return null;
  const excluded = new Set(excludedKeys);
  const previousSuggestionPlayerIds = new Set(excludedKeys.length > 0 && !eligible.some((player) => player.latePenaltyState === "PENDING") ? excludedKeys[excludedKeys.length - 1]!.split(/[|,]/).filter(Boolean) : []);
  const previouslySkippedPlayerIds = new Set(previousSuggestionPlayerIds.size > 0 ? eligible.filter((player) => !previousSuggestionPlayerIds.has(player.id)).map((player) => player.id) : []);
  const validGroup = (group: MatchPlayer[]) => { const genders = new Set(group.map((player) => player.gender)); const qualifiedLoneFemale = isQualifiedLoneFemaleGroup(group); if (mode === MatchmakingMode.SAME_GENDER && genders.size !== 1) return false; if (mode === MatchmakingMode.MIXED_DOUBLES && !((genders.size === 2 && group.filter((player) => player.gender === Gender.MALE).length === 2) || qualifiedLoneFemale)) return false; if (mode === MatchmakingMode.SAME_SKILL && new Set(group.map((player) => player.skillWeight)).size !== 1) return false; if (!hasNewbieCompatiblePartition(group)) return false; return mode !== MatchmakingMode.BALANCED || Math.max(...group.map((player) => player.skillWeight)) - Math.min(...group.map((player) => player.skillWeight)) <= strengthGap!; };
  let candidateMinimumGames = Number.POSITIVE_INFINITY;
  forEachCombination(eligible, 4, (group) => { if (validGroup(group)) candidateMinimumGames = Math.min(candidateMinimumGames, ...group.map((player) => player.gamesPlayed)); });
  if (!Number.isFinite(candidateMinimumGames)) return null;
  let fairExists = false;
  forEachCombination(eligible, 4, (group) => { if (validGroup(group) && Math.max(...group.map((player) => player.gamesPlayed)) <= candidateMinimumGames + 1) fairExists = true; });
  const hasManualOverride = (() => { let found = false; forEachCombination(eligible, 4, (group) => { if (validGroup(group) && (!fairExists || Math.max(...group.map((player) => player.gamesPlayed)) <= candidateMinimumGames + 1) && group.some((player) => player.manualPriority > 0)) found = true; }); return found; })();
  let minimumPending = Number.POSITIVE_INFINITY;
  forEachCombination(eligible, 4, (group) => { if (validGroup(group) && (!fairExists || Math.max(...group.map((player) => player.gamesPlayed)) <= candidateMinimumGames + 1)) minimumPending = Math.min(minimumPending, group.filter((player) => player.latePenaltyState === "PENDING").length); });
  let best: { key: (number[] | number | string)[]; suggestion: Suggestion } | null = null;
  forEachCombination(eligible, 4, (group) => {
    if (!validGroup(group) || (!hasManualOverride && fairExists && Math.max(...group.map((player) => player.gamesPlayed)) > candidateMinimumGames + 1)) return;
    const skillSpread = Math.max(...group.map((player) => player.skillWeight)) - Math.min(...group.map((player) => player.skillWeight));
    const recentPairs = pairStats(history, group, true);
    const allTimePairs = pairStats(history, group, false);
    const quartetId = quartetKey(group);
    const recentQuartetRepeats = history.recentQuartets?.get(quartetId) ?? 0;
    const allTimeQuartetRepeats = history.quartets.get(quartetId) ?? 0;
    const lowestGamesCount = group.filter((player) => player.gamesPlayed === candidateMinimumGames).length;
    const sortedPlayers = [...group].sort((a, b) => a.id.localeCompare(b.id));
    for (const [teamA, teamB] of partitions(sortedPlayers)) {
      const qualifiedLoneFemale = isQualifiedLoneFemaleGroup(group);
      const standardMixedDoubles = new Set(teamA.map((player) => player.gender)).size === 2 && new Set(teamB.map((player) => player.gender)).size === 2;
      if (mode === MatchmakingMode.MIXED_DOUBLES && !standardMixedDoubles && !qualifiedLoneFemale) continue;
      if (isProhibitedGeneratedGenderMatch(teamA, teamB) || isProhibitedGeneratedNewbieMatch(teamA, teamB)) continue;
      const teamATotal = teamA.reduce((sum, player) => sum + player.skillWeight, 0);
      const teamBTotal = teamB.reduce((sum, player) => sum + player.skillWeight, 0);
      const teamDifference = Math.abs(teamATotal - teamBTotal);
      if (mode === MatchmakingMode.BALANCED && teamDifference !== strengthGap!) continue;
      const recentPartnerRepeats = partnerRepeats(history, teamA, true) + partnerRepeats(history, teamB, true);
      const allTimePartnerRepeats = partnerRepeats(history, teamA, false) + partnerRepeats(history, teamB, false);
      const partnerMix = skillMix(teamA) + skillMix(teamB);
      const keyString = `${teamA.map((player) => player.id).sort().join(",")}|${teamB.map((player) => player.id).sort().join(",")}`;
      if (excluded.has(keyString)) continue;
      const priority = sortedNumbers(group.map((player) => -player.manualPriority));
      const games = sortedNumbers(group.map((player) => player.gamesPlayed));
      const times = sortedTimes(group);
      const previouslySkippedCount = group.filter((player) => previouslySkippedPlayerIds.has(player.id)).length;
      const pendingCount = group.filter((player) => player.latePenaltyState === "PENDING").length;
      const mixedShapePriority = mode === MatchmakingMode.MIXED_DOUBLES ? (standardMixedDoubles ? 0 : 1) : 0;
      const loneFemalePriority = qualifiedLoneFemale ? 0 : 1;
      const key: (number[] | number | string)[] = mode === MatchmakingMode.BALANCED
        ? [priority, -lowestGamesCount, games[3]! - games[0]!, pendingCount, mixedShapePriority, loneFemalePriority, -previouslySkippedCount, games, times, teamDifference, recentPairs.repeatedPairs, recentPairs.total, recentQuartetRepeats, allTimePairs.repeatedPairs, allTimePairs.total, allTimeQuartetRepeats, recentPartnerRepeats, allTimePartnerRepeats, -partnerMix, sortedPlayers.map((player) => player.id).join(","), keyString]
        : [priority, -lowestGamesCount, games[3]! - games[0]!, pendingCount, mixedShapePriority, loneFemalePriority, recentPairs.repeatedPairs, recentPairs.total, recentQuartetRepeats, allTimePairs.repeatedPairs, allTimePairs.total, allTimeQuartetRepeats, -previouslySkippedCount, mode === MatchmakingMode.SAME_SKILL ? skillSpread : 0, games, times, recentPartnerRepeats, allTimePartnerRepeats, 0, teamDifference, sortedPlayers.map((player) => player.id).join(","), keyString];
       const suggestion: Suggestion = { mode, teamA, teamB, teamATotal, teamBTotal, difference: teamDifference, key: keyString, explanation: { algorithmVersion: MATCHMAKING_ALGORITHM, mode, loneFemalePolicy: loneFemalePolicy(teamA, teamB, mode === MatchmakingMode.MIXED_DOUBLES), strengthGap: strengthGap ?? null, rest: { minimumRestMinutes, eligibleAt: new Date(now).toISOString() }, players: group.map((player) => ({ id: player.id, displayName: player.displayName, gamesPlayed: player.gamesPlayed, skillLevel: player.skillLevel, skillWeight: player.skillWeight, queueEnteredAt: player.queueEnteredAt?.toISOString() })), teamSkillTotals: { teamA: teamATotal, teamB: teamBTotal, difference: teamDifference }, skillDiversity: { groupSpread: skillSpread, partnerMix }, repeatPenalties: { recentPairCount: recentPairs.repeatedPairs, recentPairTotal: recentPairs.total, recentQuartetRepeats, allTimePairCount: allTimePairs.repeatedPairs, allTimePairTotal: allTimePairs.total, allTimeQuartetRepeats, recentPartnerRepeats, allTimePartnerRepeats }, partnerRotation: { recentRepeats: recentPartnerRepeats, allTimeRepeats: allTimePartnerRepeats, preservedTeamBalance: true }, lateArrival: { minimumPending, selectedPending: group.filter((player) => player.latePenaltyState === "PENDING").length, preferenceApplied: minimumPending > 0 || group.some((player) => player.latePenaltyState === "PENDING") }, fairness: { minimumGames: candidateMinimumGames, minimumGamesCount: lowestGamesCount, manualOverride: hasManualOverride, previouslySkippedCount }, fallback: null } };
      if (!best || compareCandidateKey(key, best.key) < 0) best = { key, suggestion };
    }
  });
  const selected = best as { suggestion: Suggestion } | null;
  return selected?.suggestion ?? null;
}
