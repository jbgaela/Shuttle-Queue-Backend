export type FrequentParticipant = { count: number; displayName: string; queuePlayerId: string };

export type PlayerHistoryStats = {
  averageDurationSeconds: number | null;
  mostPlayedPartner: FrequentParticipant | null;
  mostPlayedOpponent: FrequentParticipant | null;
};

export type MatchProvenance = {
  kind: "MANUAL" | "GENERATED" | "ADJUSTED_SUGGESTION" | "LEGACY_ADJUSTED";
  label: string;
  description: string;
  originalMode: string | null;
  guaranteesRetained: boolean | null;
};

export type MatchSourceValue = "MANUAL" | "AUTOMATIC" | "MANUAL_ADJUSTED";

export function matchSourceAfterLineupEdit(source: MatchSourceValue, lineupChanged: boolean): MatchSourceValue {
  if (!lineupChanged || source === "MANUAL") return source;
  return "MANUAL_ADJUSTED";
}

export function historyDurationSeconds(match: { startedAt?: Date | string | null; completedAt?: Date | string | null }) {
  if (!match.startedAt || !match.completedAt) return null;
  return Math.max(0, Math.round((new Date(match.completedAt).getTime() - new Date(match.startedAt).getTime()) / 1000));
}

function modeLabel(match: any, strengthGap: number, challengeLabel: string) {
  return match.matchmakingMode === "BALANCED" ? `Handicap +${[1, 2, 3].includes(strengthGap) ? strengthGap : 1}` : match.matchmakingMode === "GUIDED" ? "Guided" : match.matchmakingMode === "UNDEFEATED_CHALLENGE" ? challengeLabel : match.matchmakingMode === "SAME_SKILL" ? "Same skill" : match.matchmakingMode === "MIXED_DOUBLES" ? "Mixed doubles" : match.matchmakingMode === "SAME_GENDER" ? "Same gender" : match.matchmakingMode === "OPEN" ? "Open" : null;
}

function originalModeLabel(value: string | null, fallback: string) {
  return value === "BALANCED" ? "Balanced" : value === "GUIDED" ? "Guided" : value === "UNDEFEATED_CHALLENGE" ? "Undefeated challenge" : value === "SAME_SKILL" ? "Same skill" : value === "MIXED_DOUBLES" ? "Mixed doubles" : value === "SAME_GENDER" ? "Same gender" : value === "OPEN" ? "Open" : fallback;
}

export function matchProvenance(match: any, generatedLabel: string | null): MatchProvenance {
  const explanation = match.suggestionExplanation && typeof match.suggestionExplanation === "object" ? match.suggestionExplanation as Record<string, unknown> : null;
  const generatedOrigin = explanation?.generatedOrigin === "SUGGESTION" || typeof explanation?.originalMode === "string";
  if (match.source === "MANUAL") return { kind: "MANUAL", label: "Manual", description: "Teams were selected directly by the Queue Master.", originalMode: null, guaranteesRetained: null };
  if (match.source === "MANUAL_ADJUSTED" && generatedOrigin) {
    const originalMode = typeof explanation?.originalMode === "string" ? explanation.originalMode : null;
    const currentMode = generatedLabel ?? (typeof match.matchmakingMode === "string" ? match.matchmakingMode : null);
    const guaranteesRetained = Boolean(match.matchmakingMode);
    const label = currentMode ? `${currentMode} · Adjusted` : "Adjusted suggestion";
    const description = currentMode
      ? `Started as a ${originalModeLabel(originalMode, currentMode)} suggestion. The lineup was edited and still meets ${currentMode} rules.`
      : `Started as a ${originalModeLabel(originalMode, "generated")} suggestion. The lineup was edited manually, so the original mode guarantees no longer apply.`;
    return { kind: "ADJUSTED_SUGGESTION", label, description, originalMode, guaranteesRetained };
  }
  if (match.source === "MANUAL_ADJUSTED") return { kind: "LEGACY_ADJUSTED", label: "Adjusted lineup", description: "The lineup was recorded as adjusted, but its original suggestion details are unavailable.", originalMode: null, guaranteesRetained: null };
  return { kind: "GENERATED", label: generatedLabel ?? "Generated suggestion", description: `${generatedLabel ?? "Generated suggestion"} was accepted without manual lineup changes.`, originalMode: typeof explanation?.originalMode === "string" ? explanation.originalMode : null, guaranteesRetained: true };
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
  const challenge = explanation?.challenge && typeof explanation.challenge === "object" ? explanation.challenge as { appliedDisadvantage?: unknown; equalStrengthFallback?: unknown } : null;
  const challengeGap = Number(challenge?.appliedDisadvantage);
  const challengeLabel = challengeGap === 1 || challengeGap === 2 ? `Challenge +${challengeGap}` : challenge?.equalStrengthFallback === true || challengeGap === 0 ? "Equal-strength challenge" : "Undefeated challenge";
  const generatedLabel = modeLabel(match, strengthGap, challengeLabel);
  const provenance = matchProvenance(match, generatedLabel);
  return { id: match.id, source: match.source, matchmakingMode: match.matchmakingMode, matchmakingLabel: provenance.label, provenance, format: participants.length === 2 ? "SINGLES" : "DOUBLES", court, startedAt: match.startedAt, completedAt: match.completedAt, durationSeconds: historyDurationSeconds(match), winnerTeam: match.winnerTeam ?? revision?.winnerTeam ?? null, version: match.version, scoring: { pointsToWin: match.pointsToWin, winBy: match.winBy, scoreCap: match.scoreCap ?? null, bestOf: match.bestOf as 1 | 3 }, score: revision ? { revisionNumber: revision.revisionNumber, winnerTeam: revision.winnerTeam, games } : null, participants };
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
