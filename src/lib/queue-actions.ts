export type QueueBulkAction = "CHECK_IN" | "REST" | "CHECK_OUT";

export function allowedQueueStatuses(action: QueueBulkAction): string[] {
  return action === "CHECK_IN" ? ["INACTIVE", "CHECKED_OUT"] : action === "REST" ? ["WAITING"] : ["WAITING", "RESTING"];
}

export function queueActionData(player: { checkedInAt?: Date | null; latePenaltyState?: string | null }, action: QueueBulkAction, changedAt: Date, lateArrivalCutoffAt?: Date | null) {
  if (action === "CHECK_IN") {
    const late = Boolean(!player.checkedInAt && lateArrivalCutoffAt && changedAt > lateArrivalCutoffAt && !player.latePenaltyState);
    return { status: "WAITING", checkedInAt: player.checkedInAt ?? changedAt, checkedOutAt: null, queueEnteredAt: changedAt, ...(late ? { latePenaltyState: "PENDING", latePenaltyAppliedAt: changedAt } : {}) };
  }
  if (action === "REST") return { status: "RESTING", restStartedAt: changedAt };
  return { status: "CHECKED_OUT", checkedOutAt: changedAt, queueEnteredAt: null };
}
