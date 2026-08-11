export type FrequentParticipant = { count: number; displayName: string; queuePlayerId: string };

export function historyDurationSeconds(match: { startedAt?: Date | string | null; completedAt?: Date | string | null }) {
  if (!match.startedAt || !match.completedAt) return null;
  return Math.max(0, Math.round((new Date(match.completedAt).getTime() - new Date(match.startedAt).getTime()) / 1000));
}

export function historyMatchView(match: any) {
  const revisions = Array.isArray(match.scoreRevisions) ? match.scoreRevisions : [];
  const revision = revisions.find((item: any) => item.id === match.currentRevisionId) ?? [...revisions].sort((a: any, b: any) => (b.revisionNumber ?? 0) - (a.revisionNumber ?? 0))[0];
  const participants = (match.participants ?? []).map((participant: any) => ({ queuePlayerId: participant.queuePlayerId, playerId: participant.queuePlayer?.playerId, displayName: participant.queuePlayer?.displayNameSnapshot ?? "Player", gender: participant.queuePlayer?.genderSnapshot ?? "UNKNOWN", skillLevel: participant.queuePlayer?.skillLevelSnapshot ?? "UNKNOWN", team: participant.team, teamSlot: participant.teamSlot }));
  const games = revision?.games ? [...revision.games].sort((a: any, b: any) => a.gameNumber - b.gameNumber).map((game: any) => ({ gameNumber: game.gameNumber, teamAScore: game.teamAScore, teamBScore: game.teamBScore, winnerTeam: game.winnerTeam })) : [];
  const storedCourt = match.suggestionExplanation && typeof match.suggestionExplanation === "object" ? (match.suggestionExplanation as Record<string, unknown>).__courtSnapshot : null;
  const storedCourtRecord = storedCourt && typeof storedCourt === "object" ? storedCourt as { id?: unknown; name?: unknown } : null;
  const court = match.courtIdSnapshot && match.courtNameSnapshot ? { id: match.courtIdSnapshot, name: match.courtNameSnapshot } : match.court ? { id: match.court.id, name: match.court.name } : storedCourtRecord?.id && storedCourtRecord.name ? { id: String(storedCourtRecord.id), name: String(storedCourtRecord.name) } : null;
  return { id: match.id, source: match.source, matchmakingMode: match.matchmakingMode, format: participants.length === 2 ? "SINGLES" : "DOUBLES", court, startedAt: match.startedAt, completedAt: match.completedAt, durationSeconds: historyDurationSeconds(match), winnerTeam: match.winnerTeam ?? revision?.winnerTeam ?? null, score: revision ? { revisionNumber: revision.revisionNumber, winnerTeam: revision.winnerTeam, games } : null, participants };
}

export function chooseFrequentParticipant(counts: Map<string, FrequentParticipant>) {
  return [...counts.values()].sort((a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName) || a.queuePlayerId.localeCompare(b.queuePlayerId))[0] ?? null;
}
