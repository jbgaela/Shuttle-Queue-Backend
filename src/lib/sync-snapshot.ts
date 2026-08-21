export function stalePlayerFilter(playerIds: string[]) {
  return playerIds.length ? { id: { notIn: playerIds } } : {};
}

export function shouldRemoveFeeConfig(feeConfig: unknown) {
  return feeConfig === null;
}

/**
 * Restores nullable/defaulted queue-player fields omitted by older v2 clients
 * before the strict snapshot schema is applied.
 */
export function normalizeQueuePlayerSnapshotFields(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
  const value = snapshot as Record<string, unknown>;
  if (!Array.isArray(value.queuePlayers)) return snapshot;
  return {
    ...value,
    settings: value.settings && typeof value.settings === "object" && !Array.isArray(value.settings)
      ? { ...(value.settings as Record<string, unknown>), lateArrivalGraceMinutes: (value.settings as Record<string, unknown>).lateArrivalGraceMinutes ?? 10 }
      : value.settings,
    queuePlayers: value.queuePlayers.map((player) => {
      if (!player || typeof player !== "object" || Array.isArray(player)) return player;
      const queuePlayer = player as Record<string, unknown>;
      return {
        ...queuePlayer,
        queueEnteredAt: queuePlayer.queueEnteredAt === undefined ? null : queuePlayer.queueEnteredAt,
        lastMatchEndedAt: queuePlayer.lastMatchEndedAt === undefined ? null : queuePlayer.lastMatchEndedAt,
        amountDueMinor: queuePlayer.amountDueMinor === undefined ? 0 : queuePlayer.amountDueMinor,
        manualPriority: queuePlayer.manualPriority === undefined ? 0 : queuePlayer.manualPriority,
        priorityReason: queuePlayer.priorityReason === undefined ? null : queuePlayer.priorityReason,
        latePenaltyState: queuePlayer.latePenaltyState === undefined ? null : queuePlayer.latePenaltyState,
        latePenaltyAppliedAt: queuePlayer.latePenaltyAppliedAt === undefined ? null : queuePlayer.latePenaltyAppliedAt,
        currentMatchId: queuePlayer.currentMatchId === undefined ? null : queuePlayer.currentMatchId,
        checkedInAt: queuePlayer.checkedInAt === undefined ? null : queuePlayer.checkedInAt,
        checkedOutAt: queuePlayer.checkedOutAt === undefined ? null : queuePlayer.checkedOutAt,
        restStartedAt: queuePlayer.restStartedAt === undefined ? null : queuePlayer.restStartedAt,
      };
    }),
  };
}
