export type FrequentParticipant = { count: number; displayName: string; queuePlayerId: string };

export type PlayerHistoryStats = {
  averageDurationSeconds: number | null;
  mostPlayedPartner: FrequentParticipant | null;
  mostPlayedOpponent: FrequentParticipant | null;
};

export function historyDurationSeconds(match: { startedAt?: Date | string | null; completedAt?: Date | string | null }) {
  if (!match.startedAt || !match.completedAt) return null;
  return Math.max(0, Math.round((new Date(match.completedAt).getTime() - new Date(match.startedAt).getTime()) / 1000));
}

export function historyMatchView(match: any) {
  const revisions = Array.isArray(match.scoreRevisions) ? match.scoreRevisions : [];
  const revision = revisions.find((item: any) => item.id === match.currentRevisionId) ?? [...revisions].sort((a: any, b: any) => (b.revisionNumber ?? 0) - (a.revisionNumber ?? 0))[0];
  const participants = (match.participants ?? []).map((participant: any) => ({ queuePlayerId: participant.queuePlayerId, sessionPlayerId: participant.queuePlayerId, playerId: participant.queuePlayer?.playerId, displayName: participant.queuePlayer?.displayNameSnapshot ?? "Player", gender: participant.queuePlayer?.genderSnapshot ?? "UNKNOWN", skillLevel: participant.queuePlayer?.skillLevelSnapshot ?? "UNKNOWN", team: participant.team, teamSlot: participant.teamSlot }));
  const games = revision?.games ? [...revision.games].sort((a: any, b: any) => a.gameNumber - b.gameNumber).map((game: any) => ({ gameNumber: game.gameNumber, teamAScore: game.teamAScore, teamBScore: game.teamBScore, winnerTeam: game.winnerTeam })) : [];
  const storedCourt = match.suggestionExplanation && typeof match.suggestionExplanation === "object" ? (match.suggestionExplanation as Record<string, unknown>).__courtSnapshot : null;
  const storedCourtRecord = storedCourt && typeof storedCourt === "object" ? storedCourt as { id?: unknown; name?: unknown } : null;
  const court = match.courtIdSnapshot && match.courtNameSnapshot ? { id: match.courtIdSnapshot, name: match.courtNameSnapshot } : match.court ? { id: match.court.id, name: match.court.name } : storedCourtRecord?.id && storedCourtRecord.name ? { id: String(storedCourtRecord.id), name: String(storedCourtRecord.name) } : null;
  const explanation = match.suggestionExplanation && typeof match.suggestionExplanation === "object" ? match.suggestionExplanation as Record<string, unknown> : null;
  const strengthGap = Number(explanation?.strengthGap ?? 1);
  const matchmakingLabel = match.matchmakingMode === "BALANCED" ? `Handicap +${[1, 2, 3].includes(strengthGap) ? strengthGap : 1}` : match.matchmakingMode === "GUIDED" ? "Guided" : match.matchmakingMode === "UNDEFEATED_CHALLENGE" ? "Undefeated challenge" : match.matchmakingMode === "SAME_SKILL" ? "Same skill" : match.matchmakingMode === "MIXED_DOUBLES" ? "Mixed doubles" : match.matchmakingMode === "SAME_GENDER" ? "Same gender" : match.matchmakingMode === "OPEN" ? "Open" : match.source === "MANUAL_ADJUSTED" ? "Manual Adjusted" : "Manual";
  return { id: match.id, source: match.source, matchmakingMode: match.matchmakingMode, matchmakingLabel, format: participants.length === 2 ? "SINGLES" : "DOUBLES", court, startedAt: match.startedAt, completedAt: match.completedAt, durationSeconds: historyDurationSeconds(match), winnerTeam: match.winnerTeam ?? revision?.winnerTeam ?? null, score: revision ? { revisionNumber: revision.revisionNumber, winnerTeam: revision.winnerTeam, games } : null, participants };
}

export function chooseFrequentParticipant(counts: Map<string, FrequentParticipant>) {
  return [...counts.values()].sort((a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName) || a.queuePlayerId.localeCompare(b.queuePlayerId))[0] ?? null;
}

export function playerHistoryStats(matches: any[], queuePlayerId: string): PlayerHistoryStats {
  const durations: number[] = [];
  const partners = new Map<string, FrequentParticipant>();
  const opponents = new Map<string, FrequentParticipant>();
  const increment = (counts: Map<string, FrequentParticipant>, participant: any) => {
    const id = String(participant.queuePlayerId);
    const current = counts.get(id);
    counts.set(id, {
      queuePlayerId: id,
      displayName: String(participant.queuePlayer?.displayNameSnapshot ?? participant.displayName ?? "Player"),
      count: (current?.count ?? 0) + 1,
    });
  };

  for (const match of matches) {
    if (match.status && match.status !== "COMPLETED") continue;
    const selected = (match.participants ?? []).find((participant: any) => participant.queuePlayerId === queuePlayerId);
    if (!selected) continue;
    const duration = historyDurationSeconds(match);
    if (duration !== null && Number.isFinite(duration)) durations.push(duration);
    for (const participant of match.participants ?? []) {
      if (participant.queuePlayerId === queuePlayerId) continue;
      increment(participant.team === selected.team ? partners : opponents, participant);
    }
  }

  return {
    averageDurationSeconds: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    mostPlayedPartner: chooseFrequentParticipant(partners),
    mostPlayedOpponent: chooseFrequentParticipant(opponents),
  };
}
