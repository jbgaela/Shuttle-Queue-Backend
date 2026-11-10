import { QueuePlayerStatus } from "@prisma/client";
import type { CloudSnapshotV2 } from "@shuttle-queue/domain";
import { skillWeight, type SkillLevel } from "@shuttle-queue/domain";
import { badRequest } from "./errors.js";

export function snapshotQueueSummaries(snapshot: CloudSnapshotV2) {
  const activeMatchByPlayer = new Map<string, string>();
  const queuedMatchByPlayer = new Map<string, { id: string; queuedAt: string }>();
  for (const match of snapshot.matches) {
    const queuePlayerIds = new Set(
      match.participants.map((participant) => participant.queuePlayerId),
    );
    for (const queuePlayerId of queuePlayerIds) {
      if (match.status === "IN_PROGRESS") {
        const existingMatchId = activeMatchByPlayer.get(queuePlayerId);
        if (existingMatchId && existingMatchId !== match.id)
          throw badRequest("A player cannot be in more than one active match.");
        activeMatchByPlayer.set(queuePlayerId, match.id);
      } else if (match.status === "QUEUED") {
        const queued = queuedMatchByPlayer.get(queuePlayerId);
        if (
          !queued ||
          match.queuedAt.localeCompare(queued.queuedAt) < 0 ||
          (match.queuedAt === queued.queuedAt && match.id.localeCompare(queued.id) < 0)
        )
          queuedMatchByPlayer.set(queuePlayerId, { id: match.id, queuedAt: match.queuedAt });
      }
    }
  }
  const summaries = new Map<string, { status: QueuePlayerStatus; currentMatchId: string | null }>();
  for (const [queuePlayerId, matchId] of activeMatchByPlayer)
    summaries.set(queuePlayerId, {
      status: QueuePlayerStatus.PLAYING,
      currentMatchId: matchId,
    });
  for (const [queuePlayerId, match] of queuedMatchByPlayer)
    if (!activeMatchByPlayer.has(queuePlayerId))
      summaries.set(queuePlayerId, {
        status: QueuePlayerStatus.QUEUED,
        currentMatchId: match.id,
      });
  return summaries;
}

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
    settings:
      value.settings && typeof value.settings === "object" && !Array.isArray(value.settings)
        ? {
            ...(value.settings as Record<string, unknown>),
            lateArrivalGraceMinutes:
              (value.settings as Record<string, unknown>).lateArrivalGraceMinutes ?? 10,
            noShowPenaltyMinor: (value.settings as Record<string, unknown>).noShowPenaltyMinor ?? 0,
          }
        : value.settings,
    feeConfig:
      value.feeConfig && typeof value.feeConfig === "object" && !Array.isArray(value.feeConfig)
        ? {
            ...(value.feeConfig as Record<string, unknown>),
            noShowPenaltyMinor:
              (value.feeConfig as Record<string, unknown>).noShowPenaltyMinor ?? 0,
          }
        : value.feeConfig,
    players: Array.isArray(value.players)
      ? value.players.map((player) => {
          if (!player || typeof player !== "object" || Array.isArray(player)) return player;
          const profile = player as Record<string, unknown>;
          return {
            ...profile,
            skillWeight:
              typeof profile.skillLevel === "string"
                ? skillWeight(profile.skillLevel as SkillLevel)
                : profile.skillWeight,
          };
        })
      : value.players,
    queuePlayers: value.queuePlayers.map((player) => {
      if (!player || typeof player !== "object" || Array.isArray(player)) return player;
      const queuePlayer = player as Record<string, unknown>;
      return {
        ...queuePlayer,
        skillWeight:
          typeof queuePlayer.skillLevel === "string"
            ? skillWeight(queuePlayer.skillLevel as SkillLevel)
            : queuePlayer.skillWeight,
        queueEnteredAt:
          queuePlayer.queueEnteredAt === undefined ? null : queuePlayer.queueEnteredAt,
        lastMatchEndedAt:
          queuePlayer.lastMatchEndedAt === undefined ? null : queuePlayer.lastMatchEndedAt,
        amountDueMinor: queuePlayer.amountDueMinor === undefined ? 0 : queuePlayer.amountDueMinor,
        manualPriority: queuePlayer.manualPriority === undefined ? 0 : queuePlayer.manualPriority,
        priorityReason:
          queuePlayer.priorityReason === undefined ? null : queuePlayer.priorityReason,
        latePenaltyState:
          queuePlayer.latePenaltyState === undefined ? null : queuePlayer.latePenaltyState,
        latePenaltyAppliedAt:
          queuePlayer.latePenaltyAppliedAt === undefined ? null : queuePlayer.latePenaltyAppliedAt,
        currentMatchId:
          queuePlayer.currentMatchId === undefined ? null : queuePlayer.currentMatchId,
        checkedInAt: queuePlayer.checkedInAt === undefined ? null : queuePlayer.checkedInAt,
        checkedOutAt: queuePlayer.checkedOutAt === undefined ? null : queuePlayer.checkedOutAt,
        restStartedAt: queuePlayer.restStartedAt === undefined ? null : queuePlayer.restStartedAt,
      };
    }),
  };
}
