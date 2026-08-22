import { mergeSyncSnapshots, type CloudSnapshotV2, type SyncMetadata } from "@shuttle-queue/domain";
import { conflict } from "./errors.js";
import { normalizeName } from "./normalize.js";

type SyncDatabase = any;
const DEFAULT_LATE_ARRIVAL_GRACE_MINUTES = 10;

export function publicRankingRowsFromSnapshot(snapshot: CloudSnapshotV2) {
  return [...snapshot.queuePlayers]
    .sort((left, right) => right.wins - left.wins || right.matchesPlayed - left.matchesPlayed || normalizeName(left.displayName).localeCompare(normalizeName(right.displayName)))
    .map((player, index) => ({ rank: index + 1, player: player.displayName, matchesPlayed: player.matchesPlayed, wins: player.wins, losses: player.losses, winRateBasisPoints: player.matchesPlayed ? Math.floor((player.wins * 10_000) / player.matchesPlayed) : 0, pointsFor: player.pointsFor, pointsAgainst: player.pointsAgainst, pointDifferential: player.pointsFor - player.pointsAgainst }));
}

async function finalizePublicRankingFromSnapshot(tx: SyncDatabase, queueMasterId: string, sessionStartedAt: string, sessionEndedAt: Date, snapshot: CloudSnapshotV2) {
  if (!tx.publicRankingPublication?.findFirst) return;
  const publication = await tx.publicRankingPublication.findFirst({ where: { queueMasterId, sessionStartedAt: new Date(sessionStartedAt) } });
  if (!publication || publication.finalizedAt) return;
  await tx.publicRankingPublication.update({ where: { id: publication.id }, data: { sessionEndedAt, finalizedAt: sessionEndedAt, finalSnapshot: { capturedAt: sessionEndedAt.toISOString(), rankings: publicRankingRowsFromSnapshot(snapshot) }, version: { increment: 1 } } });
  await tx.auditLog.create({ data: { queueMasterId, action: "PUBLIC_RANKINGS_FINALIZED", entityType: "PUBLIC_RANKING", entityId: publication.id, reason: "Public rankings finalized during offline synchronization", beforeJson: { sessionStartedAt }, afterJson: { sessionEndedAt: sessionEndedAt.toISOString() }, requestId: `offline:sync:${sessionEndedAt.getTime()}` } });
}

export type SyncUpload = {
  schemaVersion: 2 | 3;
  deviceId: string;
  operationId: string;
  baseCloudRevision: number;
  force: boolean;
  snapshot: CloudSnapshotV2;
  metadata?: SyncMetadata;
  auditEvents: Array<Record<string, unknown>>;
};

const duplicateValues = (values: string[]) => [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
const assertUnique = (values: string[], entity: string, field: string) => {
  const duplicates = duplicateValues(values);
  if (duplicates.length) throw conflict("SYNC_SNAPSHOT_CONFLICT", "The offline snapshot contains duplicate records.", { entity, field, values: duplicates });
};

export function validateSyncSnapshot(snapshot: CloudSnapshotV2) {
  assertUnique(snapshot.players.map((player) => player.id), "players", "id");
  assertUnique(snapshot.players.map((player) => normalizeName(player.displayName)), "players", "normalizedName");
  assertUnique(snapshot.queuePlayers.map((player) => player.id), "queuePlayers", "id");
  assertUnique(snapshot.queuePlayers.map((player) => player.playerId), "queuePlayers", "playerId");
  assertUnique(snapshot.courts.map((court) => court.id), "courts", "id");
  assertUnique(snapshot.courts.map((court) => normalizeName(court.name)), "courts", "normalizedName");
  assertUnique(snapshot.matches.map((match) => match.id), "matches", "id");
  assertUnique(snapshot.payments.map((payment) => payment.id), "payments", "id");
  assertUnique(snapshot.audits.map((audit) => audit.id), "audits", "id");
  assertUnique(snapshot.matches.flatMap((match) => match.participants.map((participant) => participant.id)), "matchParticipants", "id");
  assertUnique(snapshot.matches.flatMap((match) => match.scoreRevisions.map((revision) => revision.id)), "scoreRevisions", "id");
  assertUnique(snapshot.matches.flatMap((match) => match.scoreRevisions.flatMap((revision) => revision.games.map((game) => game.id))), "matchGames", "id");

  const playerIds = new Set(snapshot.players.map((player) => player.id));
  const queuePlayerIds = new Set(snapshot.queuePlayers.map((player) => player.id));
  const matchIds = new Set(snapshot.matches.map((match) => match.id));
  const courtIds = new Set(snapshot.courts.map((court) => court.id));
  const revisionIds = new Set(snapshot.matches.flatMap((match) => match.scoreRevisions.map((revision) => revision.id)));
  const paymentIds = new Set(snapshot.payments.map((payment) => payment.id));
  if (snapshot.queuePlayers.some((player) => !playerIds.has(player.playerId))) throw conflict("SYNC_SNAPSHOT_CONFLICT", "The offline snapshot references a missing player.");
  if (snapshot.payments.some((payment) => !queuePlayerIds.has(payment.queuePlayerId))) throw conflict("SYNC_SNAPSHOT_CONFLICT", "The offline snapshot references a missing queue player.");
  if (snapshot.matches.some((match) => match.courtId !== null && match.courtId !== undefined && !courtIds.has(match.courtId))) throw conflict("SYNC_SNAPSHOT_CONFLICT", "The offline snapshot references a missing court.");
  if (snapshot.queuePlayers.some((player) => player.currentMatchId !== null && player.currentMatchId !== undefined && !matchIds.has(player.currentMatchId))) throw conflict("SYNC_SNAPSHOT_CONFLICT", "The offline snapshot references a missing current match.");
  if (snapshot.courts.some((court) => court.currentMatchId !== null && court.currentMatchId !== undefined && !matchIds.has(court.currentMatchId))) throw conflict("SYNC_SNAPSHOT_CONFLICT", "The offline snapshot references a missing court match.");
  if (snapshot.payments.some((payment) => payment.reversalOfPaymentId !== null && payment.reversalOfPaymentId !== undefined && !paymentIds.has(payment.reversalOfPaymentId))) throw conflict("SYNC_SNAPSHOT_CONFLICT", "The offline snapshot references a missing payment reversal.");

  for (const match of snapshot.matches) {
    assertUnique(match.participants.map((participant) => participant.id), "matchParticipants", "id");
    assertUnique(match.participants.map((participant) => participant.queuePlayerId), "matchParticipants", "queuePlayerId");
    assertUnique(match.participants.map((participant) => `${participant.team}:${participant.teamSlot}`), "matchParticipants", "teamSlot");
    if (match.participants.some((participant) => !queuePlayerIds.has(participant.queuePlayerId))) throw conflict("SYNC_SNAPSHOT_CONFLICT", "The offline snapshot references a missing match player.");
    if (match.participants.some((participant) => participant.matchId !== match.id)) throw conflict("SYNC_SNAPSHOT_CONFLICT", "The offline snapshot contains a participant with the wrong match reference.");
    assertUnique(match.scoreRevisions.map((revision) => revision.id), "scoreRevisions", "id");
    assertUnique(match.scoreRevisions.map((revision) => String(revision.revisionNumber)), "scoreRevisions", "revisionNumber");
    for (const revision of match.scoreRevisions) {
      if (revision.matchId !== match.id) throw conflict("SYNC_SNAPSHOT_CONFLICT", "The offline snapshot contains a score revision with the wrong match reference.");
      assertUnique(revision.games.map((game) => game.id), "matchGames", "id");
      assertUnique(revision.games.map((game) => String(game.gameNumber)), "matchGames", "gameNumber");
      if (revision.games.some((game) => game.scoreRevisionId !== revision.id)) throw conflict("SYNC_SNAPSHOT_CONFLICT", "The offline snapshot contains a game with the wrong score revision reference.");
    }
    if (match.currentRevisionId !== null && match.currentRevisionId !== undefined && !revisionIds.has(match.currentRevisionId)) throw conflict("SYNC_SNAPSHOT_CONFLICT", "The offline snapshot references a missing score revision.");
  }
  if ([...matchIds].length !== snapshot.matches.length) throw conflict("SYNC_SNAPSHOT_CONFLICT", "The offline snapshot contains duplicate matches.");
}

export async function assertStableNaturalKeys(tx: SyncDatabase, queueMasterId: string, snapshot: CloudSnapshotV2) {
  const [players, queuePlayers, courts, participants, revisions, games] = await Promise.all([
    tx.player.findMany({ where: { queueMasterId }, select: { id: true, displayName: true } }),
    tx.queuePlayer.findMany({ where: { queueMasterId }, select: { id: true, playerId: true } }),
    tx.court.findMany({ where: { queueMasterId }, select: { id: true, name: true } }),
    tx.matchParticipant.findMany({ where: { match: { queueMasterId } }, select: { id: true, matchId: true, queuePlayerId: true, team: true, teamSlot: true } }),
    tx.matchScoreRevision.findMany({ where: { match: { queueMasterId } }, select: { id: true, matchId: true, revisionNumber: true } }),
    tx.matchGame.findMany({ where: { scoreRevision: { match: { queueMasterId } } }, select: { id: true, scoreRevisionId: true, gameNumber: true } }),
  ]);
  const playerByName = new Map(players.map((player: any) => [normalizeName(player.displayName), player.id]));
  for (const player of snapshot.players) {
    const key = normalizeName(player.displayName);
    const existingId = playerByName.get(key);
    if (existingId && existingId !== player.id) throw conflict("SYNC_IDENTITY_CONFLICT", "A player identity changed while offline. Download the current queue before syncing.", { entity: "player", existingId, snapshotId: player.id, normalizedName: key });
  }
  const queuePlayerByPlayer = new Map(queuePlayers.map((player: any) => [player.playerId, player.id]));
  const queuePlayerById = new Map(queuePlayers.map((player: any) => [player.id, player.playerId]));
  for (const player of snapshot.queuePlayers) {
    const existingPlayerId = queuePlayerById.get(player.id);
    if (existingPlayerId && existingPlayerId !== player.playerId) throw conflict("SYNC_IDENTITY_CONFLICT", "A queue player was remapped to a different player while offline. Download the current queue before syncing.", { entity: "queuePlayer", existingId: player.id, snapshotId: player.id, existingPlayerId, snapshotPlayerId: player.playerId });
    const existingId = queuePlayerByPlayer.get(player.playerId);
    if (existingId && existingId !== player.id) throw conflict("SYNC_IDENTITY_CONFLICT", "A queue player identity changed while offline. Download the current queue before syncing.", { entity: "queuePlayer", existingId, snapshotId: player.id, playerId: player.playerId });
  }
  const courtByName = new Map(courts.map((court: any) => [normalizeName(court.name), court.id]));
  for (const court of snapshot.courts) {
    const key = normalizeName(court.name);
    const existingId = courtByName.get(key);
    if (existingId && existingId !== court.id) throw conflict("SYNC_IDENTITY_CONFLICT", "A court identity changed while offline. Download the current queue before syncing.", { entity: "court", existingId, snapshotId: court.id, normalizedName: key });
  }
  const participantByQueuePlayer = new Map<string, string>(participants.map((participant: any) => [`${participant.matchId}:${participant.queuePlayerId}`, participant.id]));
  const participantBySlot = new Map<string, string>(participants.map((participant: any) => [`${participant.matchId}:${participant.team}:${participant.teamSlot}`, participant.id]));
  const participantById = new Map<string, any>(participants.map((participant: any) => [participant.id, participant] as [string, any]));
  const snapshotParticipantIds = new Set(snapshot.matches.flatMap((match) => match.participants.map((participant) => participant.id)));
  const revisionByNumber = new Map(revisions.map((revision: any) => [`${revision.matchId}:${revision.revisionNumber}`, revision.id]));
  const revisionById = new Map<string, any>(revisions.map((revision: any) => [revision.id, revision] as [string, any]));
  const gameByNumber = new Map(games.map((game: any) => [`${game.scoreRevisionId}:${game.gameNumber}`, game.id]));
  const gameById = new Map<string, any>(games.map((game: any) => [game.id, game] as [string, any]));
  for (const match of snapshot.matches) {
    for (const participant of match.participants) {
      const existingParticipant = participantById.get(participant.id);
      if (existingParticipant && (existingParticipant.matchId !== participant.matchId || existingParticipant.queuePlayerId !== participant.queuePlayerId || existingParticipant.team !== participant.team || existingParticipant.teamSlot !== participant.teamSlot)) throw conflict("SYNC_IDENTITY_CONFLICT", "A match participant was remapped while offline. Download the current queue before syncing.", { entity: "matchParticipant", existingId: participant.id, snapshotId: participant.id });
      const queuePlayerId = participantByQueuePlayer.get(`${match.id}:${participant.queuePlayerId}`);
      if (queuePlayerId && queuePlayerId !== participant.id && snapshotParticipantIds.has(queuePlayerId)) throw conflict("SYNC_IDENTITY_CONFLICT", "A match participant identity changed while offline. Download the current queue before syncing.", { entity: "matchParticipant", existingId: queuePlayerId, snapshotId: participant.id, matchId: match.id, queuePlayerId: participant.queuePlayerId });
      const slotId = participantBySlot.get(`${match.id}:${participant.team}:${participant.teamSlot}`);
      if (slotId && slotId !== participant.id && snapshotParticipantIds.has(slotId)) throw conflict("SYNC_IDENTITY_CONFLICT", "A match participant slot changed while offline. Download the current queue before syncing.", { entity: "matchParticipant", existingId: slotId, snapshotId: participant.id, matchId: match.id, team: participant.team, teamSlot: participant.teamSlot });
    }
    for (const revision of match.scoreRevisions) {
      const existingRevision = revisionById.get(revision.id);
      if (existingRevision && (existingRevision.matchId !== revision.matchId || existingRevision.revisionNumber !== revision.revisionNumber)) throw conflict("SYNC_IDENTITY_CONFLICT", "A score revision was remapped while offline. Download the current queue before syncing.", { entity: "scoreRevision", existingId: revision.id, snapshotId: revision.id });
      const existingId = revisionByNumber.get(`${match.id}:${revision.revisionNumber}`);
      if (existingId && existingId !== revision.id) throw conflict("SYNC_IDENTITY_CONFLICT", "A score revision identity changed while offline. Download the current queue before syncing.", { entity: "scoreRevision", existingId, snapshotId: revision.id, matchId: match.id, revisionNumber: revision.revisionNumber });
      for (const game of revision.games) {
        const existingGame = gameById.get(game.id);
        if (existingGame && (existingGame.scoreRevisionId !== game.scoreRevisionId || existingGame.gameNumber !== game.gameNumber)) throw conflict("SYNC_IDENTITY_CONFLICT", "A game was remapped while offline. Download the current queue before syncing.", { entity: "matchGame", existingId: game.id, snapshotId: game.id });
        const gameId = gameByNumber.get(`${revision.id}:${game.gameNumber}`);
        if (gameId && gameId !== game.id) throw conflict("SYNC_IDENTITY_CONFLICT", "A game identity changed while offline. Download the current queue before syncing.", { entity: "matchGame", existingId: gameId, snapshotId: game.id, scoreRevisionId: revision.id, gameNumber: game.gameNumber });
      }
    }
  }
}

async function existingIds(tx: SyncDatabase, queueMasterId: string) {
  const [players, queuePlayers, courts, matches, participants, revisions, games, payments] = await Promise.all([
    tx.player.findMany({ where: { queueMasterId }, select: { id: true } }),
    tx.queuePlayer.findMany({ where: { queueMasterId }, select: { id: true } }),
    tx.court.findMany({ where: { queueMasterId }, select: { id: true } }),
    tx.match.findMany({ where: { queueMasterId }, select: { id: true } }),
    tx.matchParticipant.findMany({ where: { match: { queueMasterId } }, select: { id: true } }),
    tx.matchScoreRevision.findMany({ where: { match: { queueMasterId } }, select: { id: true } }),
    tx.matchGame.findMany({ where: { scoreRevision: { match: { queueMasterId } } }, select: { id: true } }),
    tx.payment.findMany({ where: { queueMasterId }, select: { id: true } }),
  ]);
  return Object.fromEntries(Object.entries({ players, queuePlayers, courts, matches, participants, revisions, games, payments }).map(([key, rows]) => [key, new Set((rows as any[]).map((row) => row.id))]));
}

const playerData = (player: CloudSnapshotV2["players"][number]) => ({ displayName: player.displayName, normalizedName: normalizeName(player.displayName), gender: player.gender, skillLevel: player.skillLevel, skillWeight: player.skillWeight, status: player.status });
const queuePlayerData = (player: CloudSnapshotV2["queuePlayers"][number]) => ({ playerId: player.playerId, displayNameSnapshot: player.displayName, normalizedNameSnapshot: normalizeName(player.displayName), genderSnapshot: player.gender, skillLevelSnapshot: player.skillLevel, skillWeightSnapshot: player.skillWeight, status: player.status, queueEnteredAt: player.queueEnteredAt ? new Date(player.queueEnteredAt) : null, lastMatchEndedAt: player.lastMatchEndedAt ? new Date(player.lastMatchEndedAt) : null, matchesPlayed: player.matchesPlayed, wins: player.wins, losses: player.losses, pointsFor: player.pointsFor, pointsAgainst: player.pointsAgainst, amountDueMinor: player.amountDueMinor ?? 0, manualPriority: player.manualPriority ?? 0, priorityReason: player.priorityReason ?? null, latePenaltyState: player.latePenaltyState ?? null, latePenaltyAppliedAt: player.latePenaltyAppliedAt ? new Date(player.latePenaltyAppliedAt) : null, currentMatchId: player.currentMatchId ?? null, checkedInAt: player.checkedInAt ? new Date(player.checkedInAt) : null, checkedOutAt: player.checkedOutAt ? new Date(player.checkedOutAt) : null, restStartedAt: player.restStartedAt ? new Date(player.restStartedAt) : null, version: player.version });
const courtData = (court: CloudSnapshotV2["courts"][number]) => ({ name: court.name, normalizedName: normalizeName(court.name), displayOrder: court.displayOrder, status: court.status, currentMatchId: court.currentMatchId ?? null, closedAt: court.closedAt ? new Date(court.closedAt) : null, version: court.version });
const matchData = (match: CloudSnapshotV2["matches"][number]) => ({ courtId: match.courtId ?? null, courtIdSnapshot: match.courtIdSnapshot ?? match.courtId ?? null, courtNameSnapshot: match.courtNameSnapshot ?? null, status: match.status, source: match.source, matchmakingMode: match.matchmakingMode ?? null, algorithmVersion: match.algorithmVersion ?? null, suggestionKey: match.suggestionKey ?? null, suggestionExplanation: match.suggestionExplanation as any, pointsToWin: match.pointsToWin, winBy: match.winBy, scoreCap: match.scoreCap, bestOf: match.bestOf, queuedAt: new Date(match.queuedAt), startedAt: match.startedAt ? new Date(match.startedAt) : null, completedAt: match.completedAt ? new Date(match.completedAt) : null, cancelledAt: match.cancelledAt ? new Date(match.cancelledAt) : null, cancellationReason: match.cancellationReason ?? null, winnerTeam: match.winnerTeam ?? null, currentRevisionId: match.currentRevisionId ?? null, version: match.version });
const participantData = (participant: CloudSnapshotV2["matches"][number]["participants"][number]) => ({ matchId: participant.matchId, queuePlayerId: participant.queuePlayerId, team: participant.team, teamSlot: participant.teamSlot, priorQueueEnteredAt: participant.priorQueueEnteredAt ? new Date(participant.priorQueueEnteredAt) : null });
const revisionData = (revision: CloudSnapshotV2["matches"][number]["scoreRevisions"][number], queueMasterId: string) => ({ matchId: revision.matchId, revisionNumber: revision.revisionNumber, winnerTeam: revision.winnerTeam, reason: revision.reason ?? null, createdByQueueMasterId: queueMasterId, supersedesRevisionId: revision.supersedesRevisionId ?? null, createdAt: revision.createdAt ? new Date(revision.createdAt) : undefined });
const gameData = (game: CloudSnapshotV2["matches"][number]["scoreRevisions"][number]["games"][number]) => ({ scoreRevisionId: game.scoreRevisionId, gameNumber: game.gameNumber, teamAScore: game.teamAScore, teamBScore: game.teamBScore, winnerTeam: game.winnerTeam });
const paymentData = (payment: CloudSnapshotV2["payments"][number]) => ({ queuePlayerId: payment.queuePlayerId, kind: payment.kind, method: payment.method, amountMinor: payment.amountMinor, reference: payment.reference, note: payment.note, reversalOfPaymentId: payment.reversalOfPaymentId, recordedById: payment.recordedById, occurredAt: new Date(payment.occurredAt), createdAt: new Date(payment.createdAt) });

export async function reconcileSyncSnapshot(tx: SyncDatabase, queueMasterId: string, snapshot: CloudSnapshotV2, auditEvents: Array<Record<string, unknown>>, operationId: string) {
  const ids = await existingIds(tx, queueMasterId);
  const write = async (model: any, id: string, data: unknown, exists: Set<string>, ownsQueueMaster = false) => exists.has(id) ? model.update({ where: { id }, data }) : model.create({ data: { id, ...(ownsQueueMaster ? { queueMasterId } : {}), ...(data as object) } });
  for (const player of snapshot.players) await write(tx.player, player.id, playerData(player), ids.players, true);
  for (const player of snapshot.queuePlayers) await write(tx.queuePlayer, player.id, queuePlayerData(player), ids.queuePlayers, true);
  for (const court of snapshot.courts) await write(tx.court, court.id, courtData(court), ids.courts, true);
  for (const match of snapshot.matches) await write(tx.match, match.id, matchData(match), ids.matches, true);
  const participantIds = snapshot.matches.flatMap((match) => match.participants.map((participant) => participant.id));
  await tx.matchParticipant.deleteMany({ where: { match: { queueMasterId }, ...(participantIds.length ? { id: { notIn: participantIds } } : {}) } });
  for (const match of snapshot.matches) {
    for (const participant of match.participants) await write(tx.matchParticipant, participant.id, participantData(participant), ids.participants);
    for (const revision of match.scoreRevisions) {
      await write(tx.matchScoreRevision, revision.id, revisionData(revision, queueMasterId), ids.revisions);
      for (const game of revision.games) await write(tx.matchGame, game.id, gameData(game), ids.games);
    }
  }
  for (const payment of snapshot.payments) await write(tx.payment, payment.id, paymentData(payment), ids.payments, true);

  const playerIds = snapshot.players.map((player) => player.id);
  const queuePlayerIds = snapshot.queuePlayers.map((player) => player.id);
  const courtIds = snapshot.courts.map((court) => court.id);
  const matchIds = snapshot.matches.map((match) => match.id);
  const revisionIds = snapshot.matches.flatMap((match) => match.scoreRevisions.map((revision) => revision.id));
  const gameIds = snapshot.matches.flatMap((match) => match.scoreRevisions.flatMap((revision) => revision.games.map((game) => game.id)));
  const paymentIds = snapshot.payments.map((payment) => payment.id);
  await tx.matchGame.deleteMany({ where: { scoreRevision: { match: { queueMasterId } }, ...(gameIds.length ? { id: { notIn: gameIds } } : {}) } });
  await tx.matchScoreRevision.deleteMany({ where: { match: { queueMasterId }, ...(revisionIds.length ? { id: { notIn: revisionIds } } : {}) } });
  await tx.match.deleteMany({ where: { queueMasterId, ...(matchIds.length ? { id: { notIn: matchIds } } : {}) } });
  await tx.payment.deleteMany({ where: { queueMasterId, ...(paymentIds.length ? { id: { notIn: paymentIds } } : {}) } });
  await tx.queuePlayer.deleteMany({ where: { queueMasterId, ...(queuePlayerIds.length ? { id: { notIn: queuePlayerIds } } : {}) } });
  await tx.court.deleteMany({ where: { queueMasterId, ...(courtIds.length ? { id: { notIn: courtIds } } : {}) } });
  await tx.player.deleteMany({ where: { queueMasterId, ...(playerIds.length ? { id: { notIn: playerIds } } : {}) } });

  if (snapshot.settings) await tx.queueMasterSettings.update({ where: { queueMasterId }, data: { pointsToWin: snapshot.settings.pointsToWin, winBy: snapshot.settings.winBy, scoreCap: snapshot.settings.scoreCap, bestOf: snapshot.settings.bestOf, minimumRestMinutes: snapshot.settings.minimumRestMinutes, lateArrivalGraceMinutes: snapshot.settings.lateArrivalGraceMinutes ?? DEFAULT_LATE_ARRIVAL_GRACE_MINUTES, defaultFeeMode: snapshot.settings.defaultFeeMode, defaultFixedFeeMinor: snapshot.settings.defaultFixedFeeMinor, currencyCode: snapshot.settings.currencyCode, timeZone: snapshot.settings.timeZone, defaultLateArrivalCutoffTime: snapshot.settings.defaultLateArrivalCutoffTime } });
  await tx.queueWorkspace.update({ where: { queueMasterId }, data: { startedAt: new Date(snapshot.workspace.startedAt), endedAt: snapshot.workspace.endedAt ? new Date(snapshot.workspace.endedAt) : null, lateArrivalCutoffAt: snapshot.workspace.lateArrivalCutoffAt ? new Date(snapshot.workspace.lateArrivalCutoffAt) : null, matchmakingAlgorithm: snapshot.workspace.matchmakingAlgorithm, matchmakingRevision: snapshot.workspace.matchmakingRevision, version: snapshot.workspace.version } });
  if (snapshot.feeConfig) await tx.queueFeeConfig.upsert({ where: { queueMasterId }, create: { queueMasterId, mode: snapshot.feeConfig.mode, currencyCode: snapshot.feeConfig.currencyCode, fixedAmountPerPlayerMinor: snapshot.feeConfig.fixedAmountPerPlayerMinor, expectedQueueCostMinor: snapshot.feeConfig.expectedQueueCostMinor, participationRule: snapshot.feeConfig.participationRule, frozenAt: snapshot.feeConfig.frozenAt ? new Date(snapshot.feeConfig.frozenAt) : null, version: snapshot.feeConfig.version }, update: { mode: snapshot.feeConfig.mode, currencyCode: snapshot.feeConfig.currencyCode, fixedAmountPerPlayerMinor: snapshot.feeConfig.fixedAmountPerPlayerMinor, expectedQueueCostMinor: snapshot.feeConfig.expectedQueueCostMinor, participationRule: snapshot.feeConfig.participationRule, frozenAt: snapshot.feeConfig.frozenAt ? new Date(snapshot.feeConfig.frozenAt) : null, version: snapshot.feeConfig.version } });
  else await tx.queueFeeConfig.deleteMany({ where: { queueMasterId } });
  for (const event of auditEvents) await tx.auditLog.create({ data: { queueMasterId, action: typeof event.action === "string" ? event.action : "OFFLINE_EVENT", entityType: typeof event.entityType === "string" ? event.entityType : "ACCOUNT", entityId: typeof event.entityId === "string" ? event.entityId : queueMasterId, reason: typeof event.reason === "string" ? event.reason : "Recorded offline", beforeJson: event.beforeJson, afterJson: event.afterJson, requestId: `offline:${operationId}` } });
}

export async function persistSyncSnapshot(tx: SyncDatabase, upload: SyncUpload, queueMasterId: string, readCurrent?: (tx: SyncDatabase) => Promise<{ snapshot: CloudSnapshotV2; metadata?: SyncMetadata }>) {
  const state = await tx.accountSyncState.upsert({ where: { queueMasterId }, create: { queueMasterId, schemaVersion: 2 }, update: {} });
  if (upload.schemaVersion === 3) {
    const receipts = tx.syncOperationReceipt;
    const priorReceipt = receipts?.findUnique ? await receipts.findUnique({ where: { queueMasterId_operationId: { queueMasterId, operationId: upload.operationId } } }) : null;
    if (priorReceipt) {
      const current = readCurrent ? await readCurrent(tx) : undefined;
      return { state, alreadyApplied: true, snapshot: current?.snapshot, metadata: current?.metadata ?? state.mergeMetadata as SyncMetadata | undefined };
    }
    validateSyncSnapshot(upload.snapshot);
    const current = readCurrent ? await readCurrent(tx) : { snapshot: upload.snapshot, metadata: state.mergeMetadata as SyncMetadata | undefined };
    const merged = mergeSyncSnapshots(upload.snapshot, current.snapshot, upload.metadata, current.metadata ?? state.mergeMetadata as SyncMetadata | undefined);
    validateSyncSnapshot(merged.snapshot);
    await assertStableNaturalKeys(tx, queueMasterId, merged.snapshot);
    const claimed = await tx.accountSyncState.updateMany({ where: { id: state.id, version: state.version }, data: { cloudRevision: { increment: 1 }, schemaVersion: 3, mergeMetadata: merged.metadata as any, lastDeviceId: upload.deviceId, lastOperationId: upload.operationId, lastSyncedAt: new Date(), version: { increment: 1 } } });
    if (claimed.count !== 1) throw conflict("SYNC_CLOUD_CHANGED", "The sync state changed while the offline changes were being merged.", { cloudRevision: state.cloudRevision });
    const currentStartedAt = current.snapshot.workspace.startedAt;
    const mergedStartedAt = merged.snapshot.workspace.startedAt;
    const sessionChanged = currentStartedAt !== mergedStartedAt;
    const sessionEnded = !current.snapshot.workspace.endedAt && Boolean(merged.snapshot.workspace.endedAt);
    if (sessionChanged || sessionEnded) {
      const finalSnapshot = sessionChanged ? current.snapshot : merged.snapshot;
      const endedAt = sessionChanged ? new Date(mergedStartedAt) : new Date(merged.snapshot.workspace.endedAt!);
      await finalizePublicRankingFromSnapshot(tx, queueMasterId, currentStartedAt, endedAt, finalSnapshot);
    }
    await reconcileSyncSnapshot(tx, queueMasterId, merged.snapshot, upload.auditEvents, upload.operationId);
    const updated = await tx.accountSyncState.findUnique({ where: { id: state.id } });
    if (!updated) throw conflict("SYNC_CLOUD_CHANGED", "The sync state changed while the snapshot was being saved.");
    if (receipts?.create) await receipts.create({ data: { queueMasterId, operationId: upload.operationId, deviceId: upload.deviceId, cloudRevision: updated.cloudRevision } });
    return { state: updated, alreadyApplied: false, snapshot: merged.snapshot, metadata: merged.metadata };
  }
  if (state.lastDeviceId === upload.deviceId && state.lastOperationId === upload.operationId) return { state, alreadyApplied: true };
  if (!upload.force && state.cloudRevision !== upload.baseCloudRevision) throw conflict("SYNC_CLOUD_CHANGED", "Cloud data changed on another device.", { cloudRevision: state.cloudRevision });
  validateSyncSnapshot(upload.snapshot);
  await assertStableNaturalKeys(tx, queueMasterId, upload.snapshot);
  const claimed = await tx.accountSyncState.updateMany({
    where: {
      id: state.id,
      version: state.version,
      ...(upload.force ? {} : { cloudRevision: upload.baseCloudRevision }),
    },
    data: {
      cloudRevision: { increment: 1 },
      schemaVersion: 2,
      lastDeviceId: upload.deviceId,
      lastOperationId: upload.operationId,
      lastSyncedAt: new Date(),
      version: { increment: 1 },
    },
  });
  if (claimed.count !== 1) throw conflict("SYNC_CLOUD_CHANGED", "Cloud data changed on another device.", { cloudRevision: state.cloudRevision });
  const current = readCurrent ? await readCurrent(tx) : { snapshot: upload.snapshot };
  const sessionChanged = current.snapshot.workspace.startedAt !== upload.snapshot.workspace.startedAt;
  const sessionEnded = !current.snapshot.workspace.endedAt && Boolean(upload.snapshot.workspace.endedAt);
  if (sessionChanged || sessionEnded) {
    const finalSnapshot = sessionChanged ? current.snapshot : upload.snapshot;
    const endedAt = sessionChanged ? new Date(upload.snapshot.workspace.startedAt) : new Date(upload.snapshot.workspace.endedAt!);
    await finalizePublicRankingFromSnapshot(tx, queueMasterId, current.snapshot.workspace.startedAt, endedAt, finalSnapshot);
  }
  await reconcileSyncSnapshot(tx, queueMasterId, upload.snapshot, upload.auditEvents, upload.operationId);
  const updated = await tx.accountSyncState.findUnique({ where: { id: state.id } });
  if (!updated) throw conflict("SYNC_CLOUD_CHANGED", "The sync state changed while the snapshot was being saved.");
  return { state: updated, alreadyApplied: false };
}
