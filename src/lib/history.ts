export type FrequentParticipant = { count: number; displayName: string; sessionPlayerId: string };

export function historyDurationSeconds(match: { startedAt?: Date | string | null; completedAt?: Date | string | null }) {
  if (!match.startedAt || !match.completedAt) return null;
  return Math.max(0, Math.round((new Date(match.completedAt).getTime() - new Date(match.startedAt).getTime()) / 1000));
}

export function historyMatchView(match: any) {
  const revisions = Array.isArray(match.scoreRevisions) ? match.scoreRevisions : [];
  const revision = revisions.find((item: any) => item.id === match.currentRevisionId) ?? [...revisions].sort((a: any, b: any) => (b.revisionNumber ?? 0) - (a.revisionNumber ?? 0))[0];
  const participants = (match.participants ?? []).map((participant: any) => ({ sessionPlayerId: participant.sessionPlayerId, playerId: participant.sessionPlayer?.playerId, displayName: participant.sessionPlayer?.displayNameSnapshot ?? "Player", gender: participant.sessionPlayer?.genderSnapshot ?? "UNKNOWN", skillLevel: participant.sessionPlayer?.skillLevelSnapshot ?? "UNKNOWN", team: participant.team, teamSlot: participant.teamSlot }));
  const games = revision?.games ? [...revision.games].sort((a: any, b: any) => a.gameNumber - b.gameNumber).map((game: any) => ({ gameNumber: game.gameNumber, teamAScore: game.teamAScore, teamBScore: game.teamBScore, winnerTeam: game.winnerTeam })) : [];
  return { id: match.id, sessionId: match.sessionId, source: match.source, matchmakingMode: match.matchmakingMode, format: participants.length === 2 ? "SINGLES" : "DOUBLES", court: match.court ? { id: match.court.id, name: match.court.name } : null, startedAt: match.startedAt, completedAt: match.completedAt, durationSeconds: historyDurationSeconds(match), winnerTeam: match.winnerTeam ?? revision?.winnerTeam ?? null, score: revision ? { revisionNumber: revision.revisionNumber, winnerTeam: revision.winnerTeam, games } : null, participants };
}

export function chooseFrequentParticipant(counts: Map<string, FrequentParticipant>) {
  return [...counts.values()].sort((a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName) || a.sessionPlayerId.localeCompare(b.sessionPlayerId))[0] ?? null;
}
