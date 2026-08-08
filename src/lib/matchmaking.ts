import { Gender, MatchmakingMode, SessionPlayerStatus } from "@prisma/client";

export type MatchPlayer = {
  id: string;
  displayName: string;
  gender: Gender;
  skillWeight: number;
  skillLevel: string;
  status: SessionPlayerStatus;
  gamesPlayed: number;
  queueEnteredAt: Date | null;
  lastMatchEndedAt: Date | null;
  manualPriority: number;
};

type PairMap = Map<string, Map<string, number>>;

export type MatchHistory = {
  partners: PairMap;
  opponents: PairMap;
  quartets: Map<string, number>;
  encounters?: PairMap;
  recentPartners?: PairMap;
  recentOpponents?: PairMap;
  recentEncounters?: PairMap;
  recentQuartets?: Map<string, number>;
};

export type Suggestion = {
  mode: MatchmakingMode;
  teamA: MatchPlayer[];
  teamB: MatchPlayer[];
  teamATotal: number;
  teamBTotal: number;
  difference: number;
  key: string;
  explanation: Record<string, unknown>;
};

const count = (map: PairMap | undefined, a: string, b: string) => map?.get(a)?.get(b) ?? 0;
const symmetricCount = (map: PairMap | undefined, a: string, b: string) => Math.max(count(map, a, b), count(map, b, a));
const quartetKey = (players: MatchPlayer[]) => players.map((player) => player.id).sort().join(":");
const sortedNumbers = (values: number[]) => [...values].sort((a, b) => a - b);
const sortedTimes = (players: MatchPlayer[]) => players.map((player) => player.queueEnteredAt?.getTime() ?? Number.MAX_SAFE_INTEGER).sort((a, b) => a - b);
const compareArrays = (a: number[], b: number[]) => {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
};

function combinations<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  const walk = (start: number, selected: T[]) => {
    if (selected.length === size) {
      result.push([...selected]);
      return;
    }
    for (let index = start; index <= items.length - (size - selected.length); index += 1) {
      selected.push(items[index]!);
      walk(index + 1, selected);
      selected.pop();
    }
  };
  walk(0, []);
  return result;
}

function partitions(players: MatchPlayer[]): [MatchPlayer[], MatchPlayer[]][] {
  const [first, second, third, fourth] = players;
  return [
    [[first, second], [third, fourth]],
    [[first, third], [second, fourth]],
    [[first, fourth], [second, third]],
  ] as [MatchPlayer[], MatchPlayer[]][];
}

function encounterCount(history: MatchHistory, a: string, b: string, recent: boolean) {
  const direct = recent ? history.recentEncounters : history.encounters;
  if (direct) return symmetricCount(direct, a, b);
  const partnerMap = recent ? history.recentPartners : history.partners;
  const opponentMap = recent ? history.recentOpponents : history.opponents;
  return Math.max(symmetricCount(partnerMap, a, b), symmetricCount(opponentMap, a, b));
}

function partnerCount(history: MatchHistory, a: string, b: string, recent: boolean) {
  return symmetricCount(recent ? history.recentPartners : history.partners, a, b);
}

function pairStats(history: MatchHistory, players: MatchPlayer[], recent: boolean) {
  const values: number[] = [];
  for (let left = 0; left < players.length; left += 1) {
    for (let right = left + 1; right < players.length; right += 1) values.push(encounterCount(history, players[left]!.id, players[right]!.id, recent));
  }
  return { repeatedPairs: values.filter((value) => value > 0).length, total: values.reduce((sum, value) => sum + value, 0) };
}

function partnerRepeats(history: MatchHistory, team: MatchPlayer[], recent: boolean) {
  return team.length === 2 ? partnerCount(history, team[0]!.id, team[1]!.id, recent) : 0;
}

function skillMix(team: MatchPlayer[]) {
  return team.length === 2 ? Math.abs(team[0]!.skillWeight - team[1]!.skillWeight) : 0;
}

export function suggestMatch(players: MatchPlayer[], mode: MatchmakingMode, history: MatchHistory, excludedKeys: string[] = []): Suggestion | null {
  const eligible = players.filter((player) => player.status === SessionPlayerStatus.WAITING && player.queueEnteredAt);
  const excluded = new Set(excludedKeys);
  const minimumGames = eligible.length ? Math.min(...eligible.map((player) => player.gamesPlayed)) : 0;
  let best: { key: (number[] | number | string)[]; suggestion: Suggestion } | null = null;

  const modeEligibleQuartets = combinations(eligible, 4).filter((quartet) => {
    const genders = new Set(quartet.map((player) => player.gender));
    if (mode === MatchmakingMode.SAME_GENDER && genders.size !== 1) return false;
    if (mode === MatchmakingMode.MIXED_DOUBLES && (genders.size !== 2 || quartet.filter((player) => player.gender === Gender.MALE).length !== 2)) return false;
    if (mode === MatchmakingMode.SAME_SKILL && new Set(quartet.map((player) => player.skillWeight)).size !== 1) return false;
    return true;
  });
  const fairnessQuartets = modeEligibleQuartets.filter((quartet) => Math.max(...quartet.map((player) => player.gamesPlayed)) <= minimumGames + 1);
  const hasManualOverride = modeEligibleQuartets.some((quartet) => quartet.some((player) => player.manualPriority > 0));
  const candidateQuartets = hasManualOverride ? modeEligibleQuartets : fairnessQuartets.length ? fairnessQuartets : modeEligibleQuartets;

  for (const quartet of candidateQuartets) {
    const skillSpread = Math.max(...quartet.map((player) => player.skillWeight)) - Math.min(...quartet.map((player) => player.skillWeight));
    const recentPairs = pairStats(history, quartet, true);
    const allTimePairs = pairStats(history, quartet, false);
    const quartetId = quartetKey(quartet);
    const recentQuartetRepeats = history.recentQuartets?.get(quartetId) ?? 0;
    const allTimeQuartetRepeats = history.quartets.get(quartetId) ?? 0;
    const lowestGamesCount = quartet.filter((player) => player.gamesPlayed === minimumGames).length;
    const sortedPlayers = [...quartet].sort((a, b) => a.id.localeCompare(b.id));

    for (const partition of partitions(sortedPlayers)) {
      const teamA = partition[0]!;
      const teamB = partition[1]!;
      if (mode === MatchmakingMode.MIXED_DOUBLES && (new Set(teamA.map((player) => player.gender)).size !== 2 || new Set(teamB.map((player) => player.gender)).size !== 2)) continue;
      const teamATotal = teamA.reduce((sum, player) => sum + player.skillWeight, 0);
      const teamBTotal = teamB.reduce((sum, player) => sum + player.skillWeight, 0);
      const teamDifference = Math.abs(teamATotal - teamBTotal);
      const recentPartnerRepeats = partnerRepeats(history, teamA, true) + partnerRepeats(history, teamB, true);
      const allTimePartnerRepeats = partnerRepeats(history, teamA, false) + partnerRepeats(history, teamB, false);
      const partnerMix = skillMix(teamA) + skillMix(teamB);
      const keyString = `${teamA.map((player) => player.id).sort().join(",")}|${teamB.map((player) => player.id).sort().join(",")}`;
      if (excluded.has(keyString)) continue;

      const priority = sortedNumbers(quartet.map((player) => -player.manualPriority));
      const games = sortedNumbers(quartet.map((player) => player.gamesPlayed));
      const gamesSpread = games[games.length - 1]! - games[0]!;
      const times = sortedTimes(quartet);
      const quartetKeyString = sortedPlayers.map((player) => player.id).join(",");
      const key: (number[] | number | string)[] = [
        priority,
        -lowestGamesCount,
        gamesSpread,
        recentPairs.repeatedPairs,
        recentPairs.total,
        recentQuartetRepeats,
        allTimePairs.repeatedPairs,
        allTimePairs.total,
        allTimeQuartetRepeats,
        mode === MatchmakingMode.BALANCED ? -skillSpread : mode === MatchmakingMode.SAME_SKILL ? skillSpread : 0,
        games,
        times,
        quartetKeyString,
        teamDifference,
        recentPartnerRepeats,
        allTimePartnerRepeats,
        mode === MatchmakingMode.BALANCED ? -partnerMix : 0,
        keyString,
      ];
      const suggestion: Suggestion = {
        mode,
        teamA,
        teamB,
        teamATotal,
        teamBTotal,
        difference: teamDifference,
        key: keyString,
        explanation: {
          mode,
          players: quartet.map((player) => ({ id: player.id, displayName: player.displayName, gamesPlayed: player.gamesPlayed, skillLevel: player.skillLevel, skillWeight: player.skillWeight, queueEnteredAt: player.queueEnteredAt?.toISOString() })),
          teamSkillTotals: { teamA: teamATotal, teamB: teamBTotal, difference: teamDifference },
          skillDiversity: { groupSpread: skillSpread, partnerMix },
          repeatPenalties: {
            recentPairCount: recentPairs.repeatedPairs,
            recentPairTotal: recentPairs.total,
            recentQuartetRepeats,
            allTimePairCount: allTimePairs.repeatedPairs,
            allTimePairTotal: allTimePairs.total,
            allTimeQuartetRepeats,
            recentPartnerRepeats,
            allTimePartnerRepeats,
          },
          partnerRotation: { recentRepeats: recentPartnerRepeats, allTimeRepeats: allTimePartnerRepeats, preservedTeamBalance: true },
          fairness: { minimumGames, minimumGamesCount: lowestGamesCount, manualOverride: hasManualOverride },
          fallback: null,
        },
      };
      if (!best || compareCandidateKey(key, best.key) < 0) best = { key, suggestion };
    }
  }
  return best?.suggestion ?? null;
}

function compareCandidateKey(a: (number[] | number | string)[], b: (number[] | number | string)[]) {
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (Array.isArray(left) && Array.isArray(right)) {
      const result = compareArrays(left as number[], right as number[]);
      if (result !== 0) return result;
    } else if (typeof left === "string" && typeof right === "string") {
      const result = left.localeCompare(right);
      if (result !== 0) return result;
    } else if (typeof left === "number" && typeof right === "number" && left !== right) {
      return left - right;
    }
  }
  return 0;
}
