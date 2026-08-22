import { createHash, createHmac, randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pino from "pino";
import pinoHttpModule from "pino-http";
import { Prisma, AccountRole, Gender, LatePenaltyState, MatchStatus, MatchSource, MatchmakingMode, PaymentKind, PaymentMethod, PlayerStatus, QueueMasterStatus, QueuePlayerStatus, TeamSide, CourtStatus, FeeMode, SkillLevel } from "@prisma/client";
import { z } from "zod";
import { prisma, withTransactionRetry } from "./lib/db.js";
import { historyDurationSeconds, historyMatchView } from "./lib/history.js";
import { config } from "./lib/config.js";
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from "./lib/errors.js";
import { normalizeName, normalizeText, normalizeUsername } from "./lib/normalize.js";
import { skillWeight } from "./lib/skills.js";
import { allocateEqualSplit, collectionTotalsByPlayer } from "./lib/fees.js";
import { allowedQueueStatuses, queueActionData } from "./lib/queue-actions.js";
import { suggestMatch, type MatchHistory, type MatchPlayer, type MatchmakingOptions } from "./lib/matchmaking.js";
import { validateScores, type ScoreInput } from "./lib/score.js";
import { normalizeQueuePlayerSnapshotFields } from "./lib/sync-snapshot.js";
import { persistSyncSnapshot, type SyncUpload } from "./lib/sync-persistence.js";
import { clearLoginFailures, clearSessionCookie, currentCsrfToken, issueSession, passwordHash, recordLoginFailure, requireAuth, requireMutationOrigin, requireSuperAdmin, rotateSession, throttleLogin, verifyPassword, type AuthenticatedRequest } from "./lib/auth.js";
import { auditLogData, type AuditValues } from "./lib/audit.js";
import { datePartsForInstant, inclusiveMinuteCutoff } from "./lib/timezone.js";
import { activePublicRankingWhere, isPublicRankingSnapshot, publicHistoryFromSnapshot, publicMatchFromRecord, publicPlayerKey, publicRankingSnapshotFromRecords, PUBLIC_RANKING_MATCH_LIMIT } from "./lib/public-rankings.js";
import type { CloudSnapshotV2 } from "@shuttle-queue/domain";

const logger = pino({ level: config.logLevel, redact: ["req.headers.cookie", "req.headers.authorization", "password", "passwordHash"] });
const pinoHttp = pinoHttpModule as unknown as (options: unknown) => RequestHandler;
const MATCHMAKING_ALGORITHM = "v3-rest-strength";
const DEFAULT_LATE_ARRIVAL_GRACE_MINUTES = 10;
const db: any = prisma;
const api = express.Router();
const idSchema = z.string().uuid();
const skillValues = Object.values(SkillLevel) as [string, ...string[]];
const genderValues = Object.values(Gender) as [string, ...string[]];
const modeValues = Object.values(MatchmakingMode) as [string, ...string[]];
const accountPasswordSchema = z.string().min(8).max(128);
const clockTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const courtNameSchema = z.string().transform((value) => normalizeText(value)).pipe(z.string().min(1).max(60));
const playerNameSchema = z.string().transform((value) => normalizeText(value)).pipe(z.string().min(1).max(80));
const PLAYER_NAME_CONFLICT_MESSAGE = "A player with this name has already been created or is already in the current queue.";
const cloudSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(2),
  queueMasterId: z.string().min(1),
  settings: z.strictObject({ id: z.string(), pointsToWin: z.number().int(), winBy: z.number().int(), scoreCap: z.number().int().nullable(), bestOf: z.union([z.literal(1), z.literal(3)]), minimumRestMinutes: z.number().int(), lateArrivalGraceMinutes: z.number().int().min(1).max(60).default(DEFAULT_LATE_ARRIVAL_GRACE_MINUTES), defaultFeeMode: z.nativeEnum(FeeMode), defaultFixedFeeMinor: z.number().int().nullable(), currencyCode: z.string(), timeZone: z.string(), defaultLateArrivalCutoffTime: z.string().nullable(), version: z.number().int() }).nullable(),
  workspace: z.strictObject({ startedAt: z.string().datetime(), endedAt: z.string().datetime().nullable().optional(), lateArrivalCutoffAt: z.string().datetime().nullable(), matchmakingAlgorithm: z.string(), matchmakingRevision: z.number().int(), version: z.number().int() }),
  players: z.array(z.strictObject({ id: z.string(), displayName: z.string(), gender: z.nativeEnum(Gender), skillLevel: z.nativeEnum(SkillLevel), skillWeight: z.number(), status: z.nativeEnum(PlayerStatus) })),
  queuePlayers: z.array(z.strictObject({ id: z.string(), playerId: z.string(), displayName: z.string(), gender: z.nativeEnum(Gender), skillLevel: z.nativeEnum(SkillLevel), skillWeight: z.number(), status: z.nativeEnum(QueuePlayerStatus), queueEnteredAt: z.string().datetime().nullable(), lastMatchEndedAt: z.string().datetime().nullable(), matchesPlayed: z.number().int(), wins: z.number().int(), losses: z.number().int(), pointsFor: z.number().int(), pointsAgainst: z.number().int(), amountDueMinor: z.number().int(), manualPriority: z.number().int(), priorityReason: z.string().nullable(), latePenaltyState: z.nativeEnum(LatePenaltyState).nullable(), latePenaltyAppliedAt: z.string().datetime().nullable(), currentMatchId: z.string().nullable(), checkedInAt: z.string().datetime().nullable(), checkedOutAt: z.string().datetime().nullable(), restStartedAt: z.string().datetime().nullable(), version: z.number().int() })),
  courts: z.array(z.strictObject({ id: z.string(), name: z.string(), normalizedName: z.string(), displayOrder: z.number().int(), status: z.nativeEnum(CourtStatus), currentMatchId: z.string().nullable(), closedAt: z.string().datetime().nullable(), version: z.number().int() })),
  matches: z.array(z.strictObject({ id: z.string(), courtId: z.string().nullable(), courtIdSnapshot: z.string().nullable().optional(), courtNameSnapshot: z.string().nullable().optional(), status: z.nativeEnum(MatchStatus), source: z.nativeEnum(MatchSource), matchmakingMode: z.nativeEnum(MatchmakingMode).nullable(), algorithmVersion: z.string().nullable(), suggestionKey: z.string().nullable(), suggestionExplanation: z.unknown(), pointsToWin: z.number().int(), winBy: z.number().int(), scoreCap: z.number().int().nullable(), bestOf: z.union([z.literal(1), z.literal(3)]), queuedAt: z.string().datetime(), startedAt: z.string().datetime().nullable(), completedAt: z.string().datetime().nullable(), cancelledAt: z.string().datetime().nullable(), cancellationReason: z.string().nullable(), winnerTeam: z.nativeEnum(TeamSide).nullable(), currentRevisionId: z.string().nullable(), version: z.number().int(), participants: z.array(z.strictObject({ id: z.string(), matchId: z.string(), queuePlayerId: z.string(), team: z.nativeEnum(TeamSide), teamSlot: z.number().int(), priorQueueEnteredAt: z.string().datetime().nullable() })), scoreRevisions: z.array(z.strictObject({ id: z.string(), matchId: z.string(), revisionNumber: z.number().int(), winnerTeam: z.nativeEnum(TeamSide), reason: z.string().nullable(), supersedesRevisionId: z.string().nullable(), createdAt: z.string().datetime(), games: z.array(z.strictObject({ id: z.string(), scoreRevisionId: z.string(), gameNumber: z.number().int(), teamAScore: z.number().int(), teamBScore: z.number().int(), winnerTeam: z.nativeEnum(TeamSide) })) })) })),
  feeConfig: z.strictObject({ id: z.string(), mode: z.nativeEnum(FeeMode), currencyCode: z.string(), fixedAmountPerPlayerMinor: z.number().int().nullable(), expectedQueueCostMinor: z.number().int().nullable(), participationRule: z.string(), frozenAt: z.string().datetime().nullable(), version: z.number().int() }).nullable(),
  payments: z.array(z.strictObject({ id: z.string(), queuePlayerId: z.string(), kind: z.nativeEnum(PaymentKind), method: z.nativeEnum(PaymentMethod).nullable(), amountMinor: z.number().int(), reference: z.string().nullable(), note: z.string().nullable(), reversalOfPaymentId: z.string().nullable(), recordedById: z.string(), occurredAt: z.string().datetime(), createdAt: z.string().datetime() })),
  audits: z.array(z.strictObject({ id: z.string(), action: z.string(), entityType: z.string(), entityId: z.string(), reason: z.string().nullable(), beforeJson: z.unknown(), afterJson: z.unknown(), requestId: z.string(), createdAt: z.string().datetime() })),
});

const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) { next(error); return; }
  const err = error instanceof AppError
    ? error
    : error instanceof z.ZodError
      ? new AppError(422, "VALIDATION_ERROR", "The request is invalid.", error.flatten())
      : error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
        ? new AppError(409, "CONFLICT", "The requested value is already in use.")
        : error instanceof Prisma.PrismaClientKnownRequestError && ["P2021", "P2022"].includes(error.code)
          ? new AppError(503, "DATABASE_SCHEMA_NOT_READY", "The backend database schema is not up to date. Run Prisma db push before using this deployment.")
        : error;
  const status = err instanceof AppError ? err.status : 500;
  if (status >= 500) {
    const prismaError = error instanceof Prisma.PrismaClientKnownRequestError ? error : null;
    logger.error({
      requestId: response.locals.requestId,
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: prismaError?.code,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
      err: error,
    }, "request failed");
  }
  response.status(status).json({ error: { code: err instanceof AppError ? err.code : "INTERNAL_ERROR", message: status >= 500 ? "An unexpected server error occurred." : err.message, ...(err instanceof AppError && err.details !== undefined ? { details: err.details } : {}) }, requestId: response.locals.requestId });
};

const route = (handler: (request: Request, response: Response) => Promise<void>): RequestHandler => (request, response, next) => { Promise.resolve(handler(request, response)).catch(next); };
const parse = <T>(schema: z.ZodType<T>, value: unknown) => {
  if (value && typeof value === "object" && (value as Record<string, unknown>).schemaVersion === 1) throw new AppError(426, "UPGRADE_REQUIRED", "This offline client must download the current queue format.");
  const parsed = schema.parse(value) as T;
  if (parsed && typeof parsed === "object" && "snapshot" in parsed && (parsed as Record<string, unknown>).schemaVersion === 2) {
    const snapshot = cloudSnapshotSchema.parse((parsed as Record<string, unknown>).snapshot);
    const playerIds = new Set(snapshot.players.map((player) => player.id));
    const queuePlayerIds = new Set(snapshot.queuePlayers.map((player) => player.id));
    if (snapshot.queuePlayers.some((player) => !playerIds.has(player.playerId)) || snapshot.matches.some((match) => match.participants.some((participant) => !queuePlayerIds.has(participant.queuePlayerId)))) throw new AppError(422, "VALIDATION_ERROR", "The snapshot contains an invalid queue reference.");
    const activeCounts = new Map<string, number>();
    for (const match of snapshot.matches) if (match.status === "IN_PROGRESS") for (const participant of match.participants) activeCounts.set(participant.queuePlayerId, (activeCounts.get(participant.queuePlayerId) ?? 0) + 1);
    if ([...activeCounts.values()].some((count) => count > 1)) throw new AppError(422, "VALIDATION_ERROR", "A player cannot be in more than one active match.");
  }
  return parsed;
};

const playerNameConflict = () => conflict("PLAYER_NAME_TAKEN", PLAYER_NAME_CONFLICT_MESSAGE);
const isUniqueConstraintError = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
async function assertPlayerNameAvailable(queueMasterId: string, displayName: string, excludedPlayerId?: string) {
  const existing = await db.player.findFirst({
    where: {
      queueMasterId,
      normalizedName: normalizeName(displayName),
      ...(excludedPlayerId ? { id: { not: excludedPlayerId } } : {}),
    },
    select: { id: true },
  });
  if (existing) throw playerNameConflict();
}
const responseData = (response: Response, data: unknown, status = 200, meta?: unknown) => response.status(status).json({ data, ...(meta === undefined ? {} : { meta }), requestId: response.locals.requestId });
const noContent = (response: Response) => response.status(204).end();
const authUser = (request: Request) => { const auth = (request as AuthenticatedRequest).auth; if (!auth) throw unauthorized(); return auth.queueMaster; };
const versionFrom = (request: Request) => { const value = request.get("if-match"); return value === undefined ? undefined : Number(value); };
const assertVersion = (actual: number, expected?: number) => { if (expected === undefined || !Number.isInteger(expected)) throw conflict("VERSION_REQUIRED", "The current workspace version is required."); if (actual !== expected) throw conflict("VERSION_CONFLICT", "The data changed on another device."); };
const owner = (request: Request, id: string | string[]) => ({ id: String(id), queueMasterId: authUser(request).id });

api.use("/sync/snapshot", requireAuth, (request, _response, next) => {
  ensureWorkspace(authUser(request).id).then(() => next()).catch(next);
});
api.use("/sync/snapshot", (request, _response, next) => {
  if (request.method === "PUT" && request.body?.snapshot && typeof request.body.snapshot === "object") {
    const normalizedSnapshot = normalizeQueuePlayerSnapshotFields(request.body.snapshot);
    request.body.snapshot = normalizedSnapshot;
    const snapshot = normalizedSnapshot as CloudSnapshotV2;
    if (Array.isArray(snapshot.queuePlayers) && Array.isArray(snapshot.matches)) {
      for (const player of snapshot.queuePlayers) {
        const summary = snapshotQueueSummary(snapshot, player.id);
        if (summary.status !== QueuePlayerStatus.WAITING || ([QueuePlayerStatus.WAITING, QueuePlayerStatus.QUEUED, QueuePlayerStatus.PLAYING] as QueuePlayerStatus[]).includes(player.status)) {
          player.status = summary.status;
          player.currentMatchId = summary.currentMatchId;
          if (summary.status !== QueuePlayerStatus.WAITING) player.queueEnteredAt = null;
        }
      }
    }
  }
  next();
});

// v3 merges a device snapshot with the current cloud state. The legacy route below
// remains available for accounts that have not yet upgraded their first device.
api.put("/sync/snapshot", requireAuth, requireMutationOrigin, (request, response, next) => {
  if (request.body?.schemaVersion !== 3) { next(); return; }
  route(async (request, response) => {
  const body = parse(z.object({ schemaVersion: z.literal(3), deviceId: z.string().min(1).max(200), operationId: z.string().min(1).max(200), baseCloudRevision: z.number().int().min(0), force: z.boolean().default(false), snapshot: z.record(z.string(), z.unknown()), metadata: z.record(z.string(), z.unknown()).optional(), auditEvents: z.array(z.record(z.string(), z.unknown())).max(2000).default([]) }), request.body);
  const snapshot = body.snapshot as unknown as CloudSnapshotV2;
  if (snapshot.queueMasterId !== authUser(request).id || (snapshot.schemaVersion !== 2 && snapshot.schemaVersion !== 3)) throw badRequest("The snapshot is not valid for this account.");
  const queueMasterId = authUser(request).id;
  const result = await withTransactionRetry((tx) => persistSyncSnapshot(tx, { ...body, snapshot, schemaVersion: 3 } as SyncUpload, queueMasterId, async () => {
    const currentState = await tx.accountSyncState.findUnique({ where: { queueMasterId } });
    return { snapshot: await snapshotWithMatchSnapshots(await buildSnapshot(queueMasterId)), metadata: currentState?.mergeMetadata as any };
  }), { maxWait: 10_000, timeout: 30_000 });
  responseData(response, { cloudRevision: result.state.cloudRevision, lastSyncedAt: result.state.lastSyncedAt, schemaVersion: 3, alreadyApplied: result.alreadyApplied, snapshot: result.snapshot, metadata: result.metadata });
  })(request, response, next);
});
api.get("/sync/snapshot", requireAuth, route(async (request, response) => {
  const queueMasterId = authUser(request).id;
  const snapshot = await snapshotWithMatchSnapshots(await buildSnapshot(queueMasterId));
  const state = await db.accountSyncState.upsert({ where: { queueMasterId }, create: { queueMasterId, schemaVersion: 2 }, update: {} });
  const upgraded = state.schemaVersion >= 3;
  const responseSnapshot = upgraded ? { ...snapshot, schemaVersion: 3 as const } : snapshot;
  responseData(response, { snapshot: responseSnapshot, checksum: snapshotChecksum(responseSnapshot), cloudRevision: state.cloudRevision, schemaVersion: upgraded ? 3 : 2, ...(upgraded ? { metadata: state.mergeMetadata } : {}) });
}));
api.get("/sync/status", requireAuth, route(async (request, response) => {
  const queueMasterId = authUser(request).id;
  const state = await db.accountSyncState.upsert({ where: { queueMasterId }, create: { queueMasterId, schemaVersion: 2 }, update: {} });
  responseData(response, { cloudRevision: state.cloudRevision, lastSyncedAt: state.lastSyncedAt, lastDeviceId: state.lastDeviceId, schemaVersion: state.schemaVersion >= 3 ? 3 : 2 });
}));
api.put("/sync/snapshot", (request, _response, next) => {
  if (request.body?.schemaVersion !== 2) { next(); return; }
  const queueMasterId = authUser(request).id;
  db.accountSyncState.findUnique({ where: { queueMasterId }, select: { schemaVersion: true } }).then((state: any) => {
    if ((state?.schemaVersion ?? 2) >= 3) { next(conflict("SYNC_CLIENT_UPGRADE_REQUIRED", "This account now uses conflict-free sync. Refresh the application before syncing.")); return; }
    next();
  }).catch(next);
});

api.use((request, _response, next) => {
  if (request.method === "GET" || !(request as AuthenticatedRequest).auth) { next(); return; }
  const allowedAfterEnd = ["/workspace/end", "/workspace/start-fresh", "/workspace/public-rankings", "/payments", "/players", "/auth/", "/admin/", "/sync/"];
  if (allowedAfterEnd.some((prefix) => request.path === prefix || request.path.startsWith(prefix))) { next(); return; }
  activeWorkspaceFor(request).then(() => next()).catch(next);
});

async function ensureWorkspace(queueMasterId: string, database = db) {
  const settings = await database.queueMasterSettings.upsert({ where: { queueMasterId }, create: { queueMasterId }, update: {} });
  const workspace = await database.queueWorkspace.upsert({ where: { queueMasterId }, create: { queueMasterId, matchmakingAlgorithm: MATCHMAKING_ALGORITHM }, update: { matchmakingAlgorithm: MATCHMAKING_ALGORITHM } });
  await database.queueFeeConfig.upsert({ where: { queueMasterId }, create: { queueMasterId, mode: settings.defaultFeeMode, currencyCode: settings.currencyCode, fixedAmountPerPlayerMinor: settings.defaultFixedFeeMinor, expectedQueueCostMinor: 0 }, update: {} });
  return { settings, workspace };
}

function accountView(account: any) {
  return { id: account.id, username: account.username, role: account.role, status: account.status, createdAt: account.createdAt, updatedAt: account.updatedAt, lastLoginAt: account.lastLoginAt, passwordChangedAt: account.passwordChangedAt, version: account.version, playerCount: account._count?.players ?? 0, queuePlayerCount: account._count?.queuePlayers ?? 0, courtCount: account._count?.courts ?? 0, matchCount: account._count?.matches ?? 0 };
}
function settingsView(settings: any) { return settings ? { id: settings.id, pointsToWin: settings.pointsToWin, winBy: settings.winBy, scoreCap: settings.scoreCap, bestOf: settings.bestOf, minimumRestMinutes: settings.minimumRestMinutes, lateArrivalGraceMinutes: settings.lateArrivalGraceMinutes ?? DEFAULT_LATE_ARRIVAL_GRACE_MINUTES, defaultFeeMode: settings.defaultFeeMode, defaultFixedFeeMinor: settings.defaultFixedFeeMinor, currencyCode: settings.currencyCode, timeZone: settings.timeZone, defaultLateArrivalCutoffTime: settings.defaultLateArrivalCutoffTime, version: settings.version } : null; }
function playerView(player: any) { return { id: player.id, displayName: player.displayName, gender: player.gender, skillLevel: player.skillLevel, skillWeight: player.skillWeight, status: player.status, version: player.version }; }
function restEligibleAt(lastMatchEndedAt: Date | null | undefined, minimumRestMinutes: number, now = Date.now()) { return !lastMatchEndedAt || minimumRestMinutes <= 0 ? new Date(now) : new Date(lastMatchEndedAt.getTime() + minimumRestMinutes * 60_000); }
function assertPlayersRestEligible(players: any[], minimumRestMinutes: number, now = Date.now()) { const blocked = players.map((player) => ({ player, eligibleAt: restEligibleAt(player.lastMatchEndedAt, minimumRestMinutes, now) })).filter((entry) => entry.eligibleAt.getTime() > now); if (blocked.length) throw conflict("REST_REQUIRED", `${blocked.map(({ player }) => player.displayNameSnapshot).join(", ")} must complete the configured rest period before playing again.`, { blockedPlayers: blocked.map(({ player, eligibleAt }) => ({ queuePlayerId: player.id, displayName: player.displayNameSnapshot, eligibleAt })), nextEligibleAt: new Date(Math.min(...blocked.map(({ eligibleAt }) => eligibleAt.getTime()))) }); }
function queuePlayerView(player: any, minimumRestMinutes = 0) { return { id: player.id, playerId: player.playerId, displayName: player.displayNameSnapshot, gender: player.genderSnapshot, skillLevel: player.skillLevelSnapshot, skillWeight: player.skillWeightSnapshot, status: player.status, queueEnteredAt: player.queueEnteredAt, lastMatchEndedAt: player.lastMatchEndedAt, restEligibleAt: restEligibleAt(player.lastMatchEndedAt, minimumRestMinutes), matchesPlayed: player.matchesPlayed, wins: player.wins, losses: player.losses, pointsFor: player.pointsFor, pointsAgainst: player.pointsAgainst, amountDueMinor: player.amountDueMinor, manualPriority: player.manualPriority, currentMatchId: player.currentMatchId, latePenaltyState: player.latePenaltyState, latePenaltyAppliedAt: player.latePenaltyAppliedAt, checkedInAt: player.checkedInAt, checkedOutAt: player.checkedOutAt, restStartedAt: player.restStartedAt, version: player.version }; }
function courtView(court: any) { return { id: court.id, name: court.name, normalizedName: court.normalizedName, displayOrder: court.displayOrder, status: court.status, currentMatchId: court.currentMatchId, closedAt: court.closedAt, version: court.version }; }
function scoreSettings(value: any) { return { pointsToWin: value.pointsToWin, winBy: value.winBy, scoreCap: value.scoreCap, bestOf: value.bestOf as 1 | 3 }; }
function matchView(match: any) { return { id: match.id, status: match.status, source: match.source, courtId: match.courtId, matchmakingMode: match.matchmakingMode, algorithmVersion: match.algorithmVersion, suggestionKey: match.suggestionKey, suggestionExplanation: match.suggestionExplanation, queuedAt: match.queuedAt, startedAt: match.startedAt, completedAt: match.completedAt, cancelledAt: match.cancelledAt, cancellationReason: match.cancellationReason, winnerTeam: match.winnerTeam, currentRevisionId: match.currentRevisionId, scoring: scoreSettings(match), version: match.version, participants: (match.participants ?? []).map((participant: any) => ({ id: participant.id, queuePlayerId: participant.queuePlayerId, displayName: participant.queuePlayer?.displayNameSnapshot, playerStatus: participant.queuePlayer?.status, lastMatchEndedAt: participant.queuePlayer?.lastMatchEndedAt, team: participant.team, teamSlot: participant.teamSlot })) }; }
function workspaceView(workspace: any, settings: any, counts: any, feeConfig?: any) { return { startedAt: workspace.startedAt, endedAt: workspace.endedAt, status: workspace.endedAt ? "ENDED" : "ACTIVE", lateArrivalCutoffAt: workspace.lateArrivalCutoffAt, matchmakingAlgorithm: workspace.matchmakingAlgorithm, matchmakingRevision: workspace.matchmakingRevision, version: workspace.version, playerCount: counts?.queuePlayers ?? 0, courtCount: counts?.courts ?? 0, scoring: scoreSettings(settings), feeConfig: feeConfig ? { id: feeConfig.id, mode: feeConfig.mode, currencyCode: feeConfig.currencyCode, fixedAmountPerPlayerMinor: feeConfig.fixedAmountPerPlayerMinor, expectedQueueCostMinor: feeConfig.expectedQueueCostMinor, participationRule: feeConfig.participationRule, frozenAt: feeConfig.frozenAt, version: feeConfig.version } : null }; }
const historyQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(15), search: z.string().max(100).default("") });
function pageResult<T>(items: T[], page: number, pageSize: number) { const total = items.length; const totalPages = Math.max(1, Math.ceil(total / pageSize)); return { items: items.slice((page - 1) * pageSize, page * pageSize), pagination: { page, pageSize, total, totalPages } }; }
function hmac(value: string) { return createHmac("sha256", config.suggestionSigningSecret).update(value).digest("base64url"); }
function signSuggestion(payload: Record<string, unknown>) { const body = Buffer.from(JSON.stringify(payload)).toString("base64url"); return `${body}.${hmac(body)}`; }
function verifySuggestion(value: string) { const [body, signature] = value.split("."); if (!body || !signature || hmac(body) !== signature) throw conflict("SUGGESTION_STALE", "Generate a new suggestion."); try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>; } catch { throw conflict("SUGGESTION_STALE", "Generate a new suggestion."); } }
async function validateSuggestionRequest(request: Request, tokenValue: string, teamA: string[], teamB: string[], adjusted: boolean) {
  const token = verifySuggestion(tokenValue);
  const workspace = await workspaceFor(request);
  const validMode = typeof token.mode === "string" && modeValues.includes(token.mode as MatchmakingMode);
  const validStrength = token.mode !== MatchmakingMode.BALANCED ? token.strengthGap === undefined : [1, 2, 3].includes(Number(token.strengthGap));
  if (token.queueMasterId !== authUser(request).id || token.revision !== workspace.matchmakingRevision || Number(token.expiresAt) < Date.now() || !validMode || !validStrength || typeof token.key !== "string" || !Array.isArray(token.teamA) || !Array.isArray(token.teamB) || (!adjusted && (JSON.stringify(token.teamA) !== JSON.stringify(teamA) || JSON.stringify(token.teamB) !== JSON.stringify(teamB)))) throw conflict("SUGGESTION_STALE", "Generate a new suggestion.");
  return token;
}
async function rebuildQueueStats(tx: any, queueMasterId: string) {
  await tx.queuePlayer.updateMany({ where: { queueMasterId }, data: { matchesPlayed: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 } });
  const completed = await tx.match.findMany({ where: { queueMasterId, status: MatchStatus.COMPLETED }, include: { participants: true, scoreRevisions: { include: { games: true } } } });
  for (const match of completed) {
    const revision = match.scoreRevisions.find((item: any) => item.id === match.currentRevisionId);
    if (!revision) continue;
    const points = revision.games.reduce((sum: { a: number; b: number }, game: any) => ({ a: sum.a + game.teamAScore, b: sum.b + game.teamBScore }), { a: 0, b: 0 });
    for (const participant of match.participants) {
      const won = participant.team === revision.winnerTeam;
      await tx.queuePlayer.update({ where: { id: participant.queuePlayerId }, data: { matchesPlayed: { increment: 1 }, wins: { increment: won ? 1 : 0 }, losses: { increment: won ? 0 : 1 }, pointsFor: { increment: participant.team === TeamSide.A ? points.a : points.b }, pointsAgainst: { increment: participant.team === TeamSide.A ? points.b : points.a } } });
    }
  }
}
async function audit(tx: any, request: Request, values: AuditValues) { await tx.auditLog.create({ data: auditLogData(authUser(request).id, String(request.id ?? randomUUID()), values) }); if (values.action === "PLAYERS_DELETED") await rebuildQueueStats(tx, authUser(request).id); }

async function workspaceFor(request: Request) { await ensureWorkspace(authUser(request).id); return db.queueWorkspace.findUnique({ where: { queueMasterId: authUser(request).id } }); }
async function activeWorkspaceFor(request: Request) { const workspace = await workspaceFor(request); if (workspace?.endedAt) throw conflict("SESSION_ENDED", "This queue session has ended. Start a fresh queue before continuing operations."); return workspace; }
async function ownedQueuePlayer(request: Request, id: string | string[]) { const player = await db.queuePlayer.findFirst({ where: { id: String(id), queueMasterId: authUser(request).id } }); if (!player) throw notFound("Queue player not found."); return player; }
async function ownedMatch(request: Request, id: string | string[], includeScore = false) { const match = await db.match.findFirst({ where: owner(request, id), include: { participants: { include: { queuePlayer: true } }, court: true, ...(includeScore ? { scoreRevisions: { include: { games: true }, orderBy: { revisionNumber: "desc" } } } : {}) } }); if (!match) throw notFound("Match not found."); return match; }
type QueuePlayerExtra = Record<string, unknown>;

async function reconcileQueuePlayers(tx: any, queueMasterId: string, queuePlayerIds: string[], releaseAt = new Date(), extras = new Map<string, QueuePlayerExtra>()) {
  const ids = [...new Set(queuePlayerIds)];
  if (!ids.length) return;
  const [activeMatches, queuedMatches] = await Promise.all([
    tx.match.findMany({ where: { queueMasterId, status: MatchStatus.IN_PROGRESS, participants: { some: { queuePlayerId: { in: ids } } } }, select: { id: true, queuedAt: true, participants: { select: { queuePlayerId: true } } }, orderBy: [{ queuedAt: "asc" }, { id: "asc" }] }),
    tx.match.findMany({ where: { queueMasterId, status: MatchStatus.QUEUED, participants: { some: { queuePlayerId: { in: ids } } } }, select: { id: true, queuedAt: true, participants: { select: { queuePlayerId: true } } }, orderBy: [{ queuedAt: "asc" }, { id: "asc" }] }),
  ]);
  const activeByPlayer = new Map<string, string>();
  const queuedByPlayer = new Map<string, string>();
  for (const match of activeMatches) for (const participant of match.participants) {
    if (activeByPlayer.has(participant.queuePlayerId)) throw conflict("PLAYER_ACTIVE_CONFLICT", "A player cannot be in more than one active match.");
    activeByPlayer.set(participant.queuePlayerId, match.id);
  }
  for (const match of queuedMatches) for (const participant of match.participants) if (!queuedByPlayer.has(participant.queuePlayerId)) queuedByPlayer.set(participant.queuePlayerId, match.id);
  for (const id of ids) {
    const activeMatchId = activeByPlayer.get(id);
    const queuedMatchId = queuedByPlayer.get(id);
    const state = activeMatchId ? QueuePlayerStatus.PLAYING : queuedMatchId ? QueuePlayerStatus.QUEUED : QueuePlayerStatus.WAITING;
    await tx.queuePlayer.update({
      where: { id },
      data: {
        status: state,
        currentMatchId: activeMatchId ?? queuedMatchId ?? null,
        queueEnteredAt: state === QueuePlayerStatus.WAITING ? releaseAt : null,
        ...extras.get(id),
        version: { increment: 1 },
      },
    });
  }
}

async function serveLatePenalties(tx: any, queueMasterId: string, queuePlayerIds: string[]) {
  const ids = [...new Set(queuePlayerIds)];
  if (!ids.length) return;
  await tx.queuePlayer.updateMany({ where: { queueMasterId, id: { in: ids }, latePenaltyState: LatePenaltyState.PENDING }, data: { latePenaltyState: LatePenaltyState.SERVED, version: { increment: 1 } } });
}

function snapshotQueueSummary(snapshot: CloudSnapshotV2, queuePlayerId: string) {
  const active = snapshot.matches.filter((match) => match.status === "IN_PROGRESS" && match.participants.some((participant) => participant.queuePlayerId === queuePlayerId));
  if (active.length > 1) throw badRequest("A player cannot be in more than one active match.");
  const queued = snapshot.matches.filter((match) => match.status === "QUEUED" && match.participants.some((participant) => participant.queuePlayerId === queuePlayerId)).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id));
  return { status: active.length ? QueuePlayerStatus.PLAYING : queued.length ? QueuePlayerStatus.QUEUED : QueuePlayerStatus.WAITING, currentMatchId: active[0]?.id ?? queued[0]?.id ?? null };
}

async function matchHistoryFor(queueMasterId: string) { const matches = await db.match.findMany({ where: { queueMasterId, status: MatchStatus.COMPLETED }, include: { participants: { include: { queuePlayer: true } }, court: true, scoreRevisions: { include: { games: true } } }, orderBy: { completedAt: "desc" }, take: 1000 }); return matches; }
async function historyMaps(queueMasterId: string): Promise<MatchHistory> {
  const history = await matchHistoryFor(queueMasterId);
  const partners = new Map<string, Map<string, number>>();
  const opponents = new Map<string, Map<string, number>>();
  const quartets = new Map<string, number>();
  const recentPartners = new Map<string, Map<string, number>>();
  const recentOpponents = new Map<string, Map<string, number>>();
  const recentQuartets = new Map<string, number>();
  const recentCounts = new Map<string, number>();
  const increment = (map: Map<string, Map<string, number>>, a: string, b: string) => { const row = map.get(a) ?? new Map<string, number>(); row.set(b, (row.get(b) ?? 0) + 1); map.set(a, row); };
  for (const match of history) {
    const participants = match.participants;
    const ids = participants.map((item: any) => item.queuePlayerId);
    const key = ids.slice().sort().join(":");
    quartets.set(key, (quartets.get(key) ?? 0) + 1);
    const recentForAll = participants.length === 4 && participants.every((participant: any) => (recentCounts.get(participant.queuePlayerId) ?? 0) < 3);
    for (const first of participants) {
      for (const second of participants) {
        if (first.id === second.id) continue;
        const partner = first.team === second.team;
        increment(partner ? partners : opponents, first.queuePlayerId, second.queuePlayerId);
        if ((recentCounts.get(first.queuePlayerId) ?? 0) < 3) increment(partner ? recentPartners : recentOpponents, first.queuePlayerId, second.queuePlayerId);
      }
    }
    if (recentForAll) recentQuartets.set(key, (recentQuartets.get(key) ?? 0) + 1);
    for (const participant of participants) if ((recentCounts.get(participant.queuePlayerId) ?? 0) < 3) recentCounts.set(participant.queuePlayerId, (recentCounts.get(participant.queuePlayerId) ?? 0) + 1);
  }
  return { partners, opponents, quartets, recentPartners, recentOpponents, recentQuartets };
}
function feePlayerStatus(due: number, collected: number, waived: number) { const outstanding = Math.max(0, due - collected - waived); return outstanding === 0 && waived > 0 ? "WAIVED" : outstanding === 0 ? "PAID" : collected > 0 ? "PARTIAL" : "UNPAID"; }
async function feeSummary(queueMasterId: string) { const configRecord = await db.queueFeeConfig.findUnique({ where: { queueMasterId } }); const players = await db.queuePlayer.findMany({ where: { queueMasterId }, orderBy: { displayNameSnapshot: "asc" } }); const payments = await db.payment.findMany({ where: { queueMasterId }, orderBy: { occurredAt: "desc" } }); const totals = collectionTotalsByPlayer(payments); const byPlayer = players.map((player: any) => { const collected = payments.filter((payment: any) => payment.queuePlayerId === player.id && payment.kind === PaymentKind.COLLECTION).reduce((sum: number, payment: any) => sum + payment.amountMinor, 0); const waived = payments.filter((payment: any) => payment.queuePlayerId === player.id && payment.kind === PaymentKind.WAIVER).reduce((sum: number, payment: any) => sum + payment.amountMinor, 0); const methodTotals = totals.get(player.id) ?? { CASH: 0, EWALLET: 0, OTHER: 0 }; return { queuePlayerId: player.id, displayName: player.displayNameSnapshot, dueMinor: player.amountDueMinor, collectedMinor: collected, waivedMinor: waived, outstandingMinor: Math.max(0, player.amountDueMinor - collected - waived), status: feePlayerStatus(player.amountDueMinor, collected, waived), collectionByMethodMinor: methodTotals }; }); return { config: configRecord, expectedMinor: byPlayer.reduce((sum: number, row: any) => sum + row.dueMinor, 0), collectedMinor: byPlayer.reduce((sum: number, row: any) => sum + row.collectedMinor, 0), outstandingMinor: byPlayer.reduce((sum: number, row: any) => sum + row.outstandingMinor, 0), paymentCount: payments.length, players: byPlayer };
}

api.use((request, response, next) => { response.once("finish", () => { const auth = (request as AuthenticatedRequest).auth; if (request.method !== "GET" && response.statusCode < 400 && auth && !request.path.startsWith("/sync/") && !request.path.startsWith("/admin/") && !request.path.startsWith("/auth/")) void db.accountSyncState.upsert({ where: { queueMasterId: auth.queueMaster.id }, create: { queueMasterId: auth.queueMaster.id, schemaVersion: 2 }, update: { cloudRevision: { increment: 1 }, schemaVersion: 2, lastSyncedAt: new Date() } }).catch(() => undefined); }); next(); });

api.post("/auth/login", route(async (request, response) => { const body = parse(z.object({ username: z.string().min(1).max(80), password: z.string().min(1).max(128) }), request.body); const key = `${request.ip}:${normalizeUsername(body.username)}`; if (!(await throttleLogin(key))) throw conflict("LOGIN_THROTTLED", "Too many failed login attempts. Try again later."); const account = await db.queueMaster.findUnique({ where: { normalizedUsername: normalizeUsername(body.username) } }); if (!account || account.status !== QueueMasterStatus.ACTIVE || !(await verifyPassword(account.passwordHash, body.password).catch(() => false))) { await recordLoginFailure(key); throw unauthorized("Invalid username or password."); } await clearLoginFailures(key); await db.queueMaster.update({ where: { id: account.id }, data: { lastLoginAt: new Date() } }); await ensureWorkspace(account.id); const issued = await issueSession(account.id, request, response); responseData(response, { user: { id: account.id, username: account.username, role: account.role }, csrfToken: issued.csrfToken, expiresAt: issued.expiresAt }, 200); }));
api.get("/auth/me", requireAuth, route(async (request, response) => { const user = authUser(request); const csrfToken = await currentCsrfToken(request as AuthenticatedRequest, response); responseData(response, { user: { id: user.id, username: user.username, role: user.role }, csrfToken }); }));
api.post("/auth/renew", requireAuth, requireMutationOrigin, route(async (request, response) => { const renewed = await rotateSession(request as AuthenticatedRequest, response); responseData(response, renewed); }));
api.post("/auth/logout", requireAuth, requireMutationOrigin, route(async (request, response) => { const auth = (request as AuthenticatedRequest).auth!; await db.authSession.update({ where: { id: auth.sessionId }, data: { revokedAt: new Date(), revokeReason: "logout" } }); clearSessionCookie(response); noContent(response); }));
api.post("/auth/change-password", requireAuth, requireMutationOrigin, route(async (request, response) => { const body = parse(z.object({ currentPassword: z.string(), newPassword: accountPasswordSchema }), request.body); const user = authUser(request); if (!(await verifyPassword(user.passwordHash, body.currentPassword).catch(() => false))) throw unauthorized("The current password is incorrect."); const updated = await db.queueMaster.update({ where: { id: user.id }, data: { passwordHash: await passwordHash(body.newPassword), passwordChangedAt: new Date(), version: { increment: 1 } } }); responseData(response, { user: { id: updated.id, username: updated.username, role: updated.role } }); }));

api.get("/settings", requireAuth, route(async (request, response) => { const { settings } = await ensureWorkspace(authUser(request).id); responseData(response, settingsView(settings)); }));
api.patch("/settings", requireAuth, requireMutationOrigin, route(async (request, response) => { const current = (await ensureWorkspace(authUser(request).id)).settings; assertVersion(current.version, versionFrom(request)); const body = parse(z.object({ pointsToWin: z.number().int().min(1).max(99).optional(), winBy: z.number().int().min(1).max(10).optional(), scoreCap: z.number().int().min(1).max(99).nullable().optional(), bestOf: z.union([z.literal(1), z.literal(3)]).optional(), minimumRestMinutes: z.number().int().min(0).max(60).optional(), lateArrivalGraceMinutes: z.number().int().min(1).max(60).optional(), defaultFeeMode: z.enum([FeeMode.FIXED_PER_PLAYER, FeeMode.EQUAL_SPLIT]).optional(), defaultFixedFeeMinor: z.number().int().min(0).max(2_000_000_000).nullable().optional(), defaultLateArrivalCutoffTime: clockTimeSchema.nullable().optional() }), request.body); const points = body.pointsToWin ?? current.pointsToWin; const scoreCap = body.scoreCap === undefined ? current.scoreCap : body.scoreCap; if (scoreCap !== null && scoreCap < points) throw badRequest("The score cap cannot be lower than points to win."); const updated = await db.queueMasterSettings.update({ where: { id: current.id }, data: { ...body, pointsToWin: points, scoreCap, version: { increment: 1 } } }); responseData(response, settingsView(updated)); }));

api.get("/workspace", requireAuth, route(async (request, response) => { const { settings, workspace } = await ensureWorkspace(authUser(request).id); const counts = await db.queueMaster.findUnique({ where: { id: authUser(request).id }, select: { _count: { select: { queuePlayers: true, courts: true } } } }); const fee = await db.queueFeeConfig.findUnique({ where: { queueMasterId: authUser(request).id } }); responseData(response, workspaceView(workspace, settings, counts?._count, fee)); }));
api.post("/workspace/start-fresh", requireAuth, requireMutationOrigin, route(async (request, response) => { const queueMasterId = authUser(request).id; const current = await db.queueWorkspace.findUnique({ where: { queueMasterId } }); if (!current) { await ensureWorkspace(queueMasterId); } const expected = versionFrom(request); assertVersion(current?.version ?? 1, expected); const settings = await db.queueMasterSettings.findUnique({ where: { queueMasterId } }); const result = await withTransactionRetry(async (tx) => { const resetAt = new Date(); const workspaceBeforeReset = await tx.queueWorkspace.findUnique({ where: { queueMasterId } }); if (workspaceBeforeReset) await finalizePublicRankingPublication(tx, queueMasterId, workspaceBeforeReset, resetAt); await tx.matchGame.deleteMany({ where: { scoreRevision: { match: { queueMasterId } } } }); await tx.matchScoreRevision.deleteMany({ where: { match: { queueMasterId } } }); await tx.matchParticipant.deleteMany({ where: { match: { queueMasterId } } }); await tx.match.deleteMany({ where: { queueMasterId } }); await tx.payment.deleteMany({ where: { queueMasterId } }); await tx.queuePlayer.deleteMany({ where: { queueMasterId } }); await tx.court.deleteMany({ where: { queueMasterId } }); await tx.auditLog.deleteMany({ where: { queueMasterId, entityType: { in: ["MATCH", "QUEUE_PLAYER", "COURT", "WORKSPACE", "PAYMENT", "FEE_CONFIG"] } } }); await tx.idempotencyRecord.deleteMany({ where: { queueMasterId, operation: "PAYMENT_CREATE" } }); const workspace = await tx.queueWorkspace.update({ where: { queueMasterId, version: expected }, data: { startedAt: resetAt, endedAt: null, lateArrivalCutoffAt: null, matchmakingRevision: { increment: 1 }, version: { increment: 1 } } }); await tx.queueFeeConfig.upsert({ where: { queueMasterId }, create: { queueMasterId, mode: settings?.defaultFeeMode ?? FeeMode.FIXED_PER_PLAYER, currencyCode: settings?.currencyCode ?? "PHP", fixedAmountPerPlayerMinor: settings?.defaultFixedFeeMinor ?? null, expectedQueueCostMinor: 0 }, update: { mode: settings?.defaultFeeMode ?? FeeMode.FIXED_PER_PLAYER, currencyCode: settings?.currencyCode ?? "PHP", fixedAmountPerPlayerMinor: settings?.defaultFixedFeeMinor ?? null, expectedQueueCostMinor: 0, frozenAt: null, version: { increment: 1 } } }); return workspace; }); responseData(response, workspaceView(result, settings, { queuePlayers: 0, courts: 0 }, await db.queueFeeConfig.findUnique({ where: { queueMasterId } }))); }));
api.patch("/workspace/late-arrival-policy", requireAuth, requireMutationOrigin, route(async (request, response) => {
  const workspace = await workspaceFor(request);
  assertVersion(workspace.version, versionFrom(request));
  const settings = (await ensureWorkspace(authUser(request).id)).settings;
  const body = parse(z.discriminatedUnion("mode", [z.object({ mode: z.literal("SET_NOW") }), z.object({ mode: z.literal("START_GRACE") }), z.object({ mode: z.literal("APPLY_ACCOUNT_DEFAULT") }), z.object({ mode: z.literal("SET_CUSTOM"), localDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/) }), z.object({ mode: z.literal("DISABLED") })]), request.body);
  let cutoff: Date | null = null;
  try {
    if (body.mode === "SET_NOW") cutoff = new Date();
    else if (body.mode === "START_GRACE") cutoff = new Date(Date.now() + (settings.lateArrivalGraceMinutes ?? DEFAULT_LATE_ARRIVAL_GRACE_MINUTES) * 60_000);
    else if (body.mode === "APPLY_ACCOUNT_DEFAULT" && settings.defaultLateArrivalCutoffTime) cutoff = inclusiveMinuteCutoff(`${datePartsForInstant(new Date(), settings.timeZone)}T${settings.defaultLateArrivalCutoffTime}`, settings.timeZone);
    else if (body.mode === "SET_CUSTOM") cutoff = inclusiveMinuteCutoff(body.localDateTime, settings.timeZone);
  } catch {
    throw badRequest("The cutoff time is invalid for the account timezone.");
  }
  const queueMasterId = authUser(request).id;
  let reclassifiedPlayerCount = 0;
  const updated = await withTransactionRetry(async (tx) => {
    const next = await tx.queueWorkspace.update({ where: { queueMasterId, version: workspace.version }, data: { lateArrivalCutoffAt: cutoff, matchmakingRevision: { increment: 1 }, version: { increment: 1 } } });
    const pendingWhere = body.mode === "DISABLED"
      ? { queueMasterId, latePenaltyState: LatePenaltyState.PENDING }
      : cutoff
        ? { queueMasterId, latePenaltyState: LatePenaltyState.PENDING, OR: [{ checkedInAt: { lte: cutoff } }, { checkedInAt: null, latePenaltyAppliedAt: { lte: cutoff } }] }
        : null;
    if (pendingWhere) {
      const repaired = await tx.queuePlayer.updateMany({ where: pendingWhere, data: { latePenaltyState: null, latePenaltyAppliedAt: null, version: { increment: 1 } } });
      reclassifiedPlayerCount = repaired.count;
    }
    await audit(tx, request, { action: "LATE_ARRIVAL_POLICY_UPDATED", entityType: "WORKSPACE", entityId: queueMasterId, reason: `Arrival cutoff updated (${body.mode}); ${reclassifiedPlayerCount} pending player(s) reclassified as on time.`, before: { lateArrivalCutoffAt: workspace.lateArrivalCutoffAt?.toISOString() ?? null }, after: { lateArrivalCutoffAt: cutoff?.toISOString() ?? null, reclassifiedPlayerCount } });
    return next;
  });
  const account = await db.queueMaster.findUnique({ where: { id: queueMasterId }, select: { _count: { select: { queuePlayers: true, courts: true } } } });
  responseData(response, { ...workspaceView(updated, settings, account?._count, await db.queueFeeConfig.findUnique({ where: { queueMasterId } })), reclassifiedPlayerCount });
}));

api.get("/players", requireAuth, route(async (request, response) => { const status = request.query.status === "ALL" ? undefined : PlayerStatus.ACTIVE; const rows = await db.player.findMany({ where: { queueMasterId: authUser(request).id, ...(status ? { status } : {}) }, orderBy: { normalizedName: "asc" } }); responseData(response, rows.map(playerView)); }));
api.post("/players", requireAuth, requireMutationOrigin, route(async (request, response) => {
  const body = parse(z.object({ displayName: playerNameSchema, gender: z.enum(genderValues), skillLevel: z.enum(skillValues) }), request.body);
  const queueMasterId = authUser(request).id;
  await assertPlayerNameAvailable(queueMasterId, body.displayName);
  try {
    const player = await db.player.create({ data: { queueMasterId, displayName: body.displayName, normalizedName: normalizeName(body.displayName), gender: body.gender, skillLevel: body.skillLevel, skillWeight: skillWeight(body.skillLevel as SkillLevel) } });
    responseData(response, playerView(player), 201);
  } catch (error) {
    if (isUniqueConstraintError(error)) throw playerNameConflict();
    throw error;
  }
}));
api.patch("/players/:id", requireAuth, requireMutationOrigin, route(async (request, response) => {
  const queueMasterId = authUser(request).id;
  const current = await db.player.findFirst({ where: owner(request, request.params.id) });
  if (!current) throw notFound("Player not found.");
  assertVersion(current.version, versionFrom(request));
  const body = parse(z.object({ displayName: playerNameSchema.optional(), gender: z.enum(genderValues).optional(), skillLevel: z.enum(skillValues).optional(), status: z.enum([PlayerStatus.ACTIVE, PlayerStatus.INACTIVE]).optional() }), request.body);
  const displayName = body.displayName ?? current.displayName;
  const gender = body.gender ?? current.gender;
  const level = body.skillLevel ?? current.skillLevel;
  const weight = skillWeight(level as SkillLevel);
  const profileChanged = displayName !== current.displayName || gender !== current.gender || level !== current.skillLevel;
  if (body.displayName !== undefined) await assertPlayerNameAvailable(queueMasterId, displayName, current.id);
  try {
    const player = await withTransactionRetry(async (tx) => {
      const updated = await tx.player.update({ where: { id: current.id }, data: { displayName, normalizedName: normalizeName(displayName), gender, skillLevel: level, skillWeight: weight, status: body.status, version: { increment: 1 } } });
      if (profileChanged) {
        const queuePlayers = await tx.queuePlayer.updateMany({ where: { queueMasterId, playerId: current.id }, data: { displayNameSnapshot: displayName, normalizedNameSnapshot: normalizeName(displayName), genderSnapshot: gender, skillLevelSnapshot: level, skillWeightSnapshot: weight, version: { increment: 1 } } });
        if (queuePlayers.count) await tx.queueWorkspace.update({ where: { queueMasterId }, data: { matchmakingRevision: { increment: 1 }, version: { increment: 1 } } });
      }
      await audit(tx, request, { action: "PLAYER_UPDATED", entityType: "PLAYER", entityId: current.id, before: playerView(current), after: playerView(updated) });
      return updated;
    });
    responseData(response, playerView(player));
  } catch (error) {
    if (isUniqueConstraintError(error)) throw playerNameConflict();
    throw error;
  }
}));
api.post("/players/:id/archive", requireAuth, requireMutationOrigin, route(async (request, response) => { const current = await db.player.findFirst({ where: owner(request, request.params.id) }); if (!current) throw notFound("Player not found."); assertVersion(current.version, versionFrom(request)); responseData(response, playerView(await db.player.update({ where: { id: current.id }, data: { status: PlayerStatus.ARCHIVED, archivedAt: new Date(), version: { increment: 1 } } }))); }));
api.post("/players/:id/restore", requireAuth, requireMutationOrigin, route(async (request, response) => { const current = await db.player.findFirst({ where: owner(request, request.params.id) }); if (!current) throw notFound("Player not found."); assertVersion(current.version, versionFrom(request)); responseData(response, playerView(await db.player.update({ where: { id: current.id }, data: { status: PlayerStatus.ACTIVE, archivedAt: null, version: { increment: 1 } } }))); }));

async function deletionImpact(queueMasterId: string, playerIds: string[]) { const ids = [...new Set(playerIds)]; const players = await db.player.findMany({ where: { id: { in: ids }, queueMasterId } }); if (players.length !== ids.length) throw conflict("PLAYER_NOT_FOUND", "One or more players were not found."); const queuePlayers = await db.queuePlayer.findMany({ where: { queueMasterId, playerId: { in: ids } } }); const qpIds = queuePlayers.map((p: any) => p.id); const matches = await db.match.findMany({ where: { queueMasterId, participants: { some: { queuePlayerId: { in: qpIds } } } }, select: { id: true, participants: { select: { queuePlayerId: true } } } }); const otherQpIds = [...new Set(matches.flatMap((m: any) => m.participants.map((p: any) => p.queuePlayerId)).filter((id: string) => !qpIds.includes(id)))]; const others = await db.queuePlayer.findMany({ where: { id: { in: otherQpIds } }, select: { playerId: true } }); return { playerIds: ids, playerNames: players.map((p: any) => p.displayName), busyPlayers: queuePlayers.filter((p: any) => p.status === QueuePlayerStatus.QUEUED || p.status === QueuePlayerStatus.PLAYING).map((p: any) => ({ playerId: p.playerId, queuePlayerId: p.id, displayName: p.displayNameSnapshot, status: p.status })), affectedMatchIds: matches.map((m: any) => m.id), affectedPaymentIds: (await db.payment.findMany({ where: { queueMasterId, queuePlayerId: { in: qpIds } }, select: { id: true } })).map((p: any) => p.id), otherParticipantPlayerIds: [...new Set(others.map((p: any) => p.playerId))], otherParticipantQueuePlayerIds: otherQpIds }; }
api.post("/players/deletion-preview", requireAuth, route(async (request, response) => { const body = parse(z.object({ playerIds: z.array(idSchema).min(1).max(100) }), request.body); responseData(response, await deletionImpact(authUser(request).id, body.playerIds)); }));
api.post("/players/delete", requireAuth, requireMutationOrigin, route(async (request, response) => { const body = parse(z.object({ playerIds: z.array(idSchema).min(1).max(100) }), request.body); const impact = await deletionImpact(authUser(request).id, body.playerIds); if (impact.busyPlayers.length) throw conflict("PLAYER_BUSY", "Busy players must finish or be discarded before deletion."); const result = await withTransactionRetry(async (tx) => { await tx.matchGame.deleteMany({ where: { scoreRevision: { match: { id: { in: impact.affectedMatchIds } } } } }); await tx.matchScoreRevision.deleteMany({ where: { matchId: { in: impact.affectedMatchIds } } }); await tx.matchParticipant.deleteMany({ where: { matchId: { in: impact.affectedMatchIds } } }); await tx.match.deleteMany({ where: { id: { in: impact.affectedMatchIds } } }); await tx.payment.deleteMany({ where: { queueMasterId: authUser(request).id, id: { in: impact.affectedPaymentIds } } }); await tx.queuePlayer.deleteMany({ where: { queueMasterId: authUser(request).id, playerId: { in: body.playerIds } } }); await tx.player.deleteMany({ where: { id: { in: body.playerIds }, queueMasterId: authUser(request).id } }); await tx.queueWorkspace.update({ where: { queueMasterId: authUser(request).id }, data: { matchmakingRevision: { increment: 1 }, version: { increment: 1 } } }); await audit(tx, request, { action: "PLAYERS_DELETED", entityType: "ACCOUNT", entityId: authUser(request).id, reason: "Permanent player deletion", before: impact }); return impact; }); responseData(response, { deletedPlayerIds: result.playerIds, affectedMatchCount: result.affectedMatchIds.length, affectedPaymentCount: result.affectedPaymentIds.length, otherParticipantPlayerIds: result.otherParticipantPlayerIds }); }));

api.get("/queue/players", requireAuth, route(async (request, response) => { await ensureWorkspace(authUser(request).id); responseData(response, (await db.queuePlayer.findMany({ where: { queueMasterId: authUser(request).id }, orderBy: [{ status: "asc" }, { queueEnteredAt: "asc" }] })).map(queuePlayerView)); }));
api.post("/queue/players", requireAuth, requireMutationOrigin, route(async (request, response) => { const body = parse(z.object({ playerIds: z.array(idSchema).min(1).max(100) }), request.body); const ids = [...new Set(body.playerIds)]; const roster = await db.player.findMany({ where: { id: { in: ids }, queueMasterId: authUser(request).id, status: PlayerStatus.ACTIVE } }); if (roster.length !== ids.length) throw conflict("PLAYER_INELIGIBLE", "Every selected player must be active and owned by you."); const existing = await db.queuePlayer.findMany({ where: { queueMasterId: authUser(request).id, playerId: { in: ids } } }); if (existing.length) throw conflict("PLAYER_ALREADY_IN_QUEUE", "One or more players are already in the queue."); const rows = await db.$transaction((tx: any) => Promise.all(roster.map((player: any) => tx.queuePlayer.create({ data: { queueMasterId: authUser(request).id, playerId: player.id, displayNameSnapshot: player.displayName, normalizedNameSnapshot: player.normalizedName, genderSnapshot: player.gender, skillLevelSnapshot: player.skillLevel, skillWeightSnapshot: player.skillWeight } })))); responseData(response, rows.map(queuePlayerView), 201); }));
api.post("/queue/players/bulk-action", requireAuth, requireMutationOrigin, route(async (request, response) => {
  const body = parse(z.object({ playerIds: z.array(idSchema).min(1).max(100), action: z.enum(["CHECK_IN", "REST", "CHECK_OUT"]) }), request.body);
  const ids = [...new Set(body.playerIds)];
  if (ids.length !== body.playerIds.length) throw conflict("INVALID_PLAYER_SELECTION", "Each player can only be selected once.");
  const workspace = await activeWorkspaceFor(request);
  const queueMasterId = authUser(request).id;
  const updated = await withTransactionRetry(async (tx) => {
    const players = await tx.queuePlayer.findMany({ where: { id: { in: ids }, queueMasterId } });
    if (players.length !== ids.length) throw conflict("PLAYER_NOT_FOUND", "One or more selected players could not be found.");
    const allowed: string[] = allowedQueueStatuses(body.action);
    const invalid = players.filter((player: any) => !allowed.includes(player.status));
    if (invalid.length) throw conflict("INVALID_PLAYER_TRANSITION", "One or more selected players are no longer eligible for this action.", { playerIds: invalid.map((player: any) => player.id) });
    const changedAt = new Date();
    await Promise.all(players.map((player: any) => {
      const data = queueActionData(player, body.action, changedAt, workspace?.lateArrivalCutoffAt) as any;
      return tx.queuePlayer.update({ where: { id: player.id }, data: { ...data, version: { increment: 1 } } });
    }));
    return tx.queuePlayer.findMany({ where: { id: { in: ids }, queueMasterId } });
  });
  responseData(response, updated.map(queuePlayerView));
}));
api.post("/queue/players/:id/check-in", requireAuth, requireMutationOrigin, route(async (request, response) => { const player = await ownedQueuePlayer(request, request.params.id); if (![QueuePlayerStatus.INACTIVE, QueuePlayerStatus.CHECKED_OUT].includes(player.status)) throw conflict("INVALID_PLAYER_TRANSITION", "The player cannot be checked in from the current state."); const workspace = await workspaceFor(request); const checkedInAt = new Date(); const data = queueActionData(player, "CHECK_IN", checkedInAt, workspace?.lateArrivalCutoffAt) as any; const updated = await db.queuePlayer.update({ where: { id: player.id }, data: { ...data, version: { increment: 1 } } }); responseData(response, queuePlayerView(updated)); }));
api.post("/queue/players/:id/rest", requireAuth, requireMutationOrigin, route(async (request, response) => { const player = await ownedQueuePlayer(request, request.params.id); if (player.status !== QueuePlayerStatus.WAITING) throw conflict("INVALID_PLAYER_TRANSITION", "Only waiting players can rest."); responseData(response, queuePlayerView(await db.queuePlayer.update({ where: { id: player.id }, data: { status: QueuePlayerStatus.RESTING, restStartedAt: new Date(), version: { increment: 1 } } }))); }));
api.post("/queue/players/:id/resume", requireAuth, requireMutationOrigin, route(async (request, response) => { const player = await ownedQueuePlayer(request, request.params.id); if (player.status !== QueuePlayerStatus.RESTING) throw conflict("INVALID_PLAYER_TRANSITION", "Only resting players can resume."); responseData(response, queuePlayerView(await db.queuePlayer.update({ where: { id: player.id }, data: { status: QueuePlayerStatus.WAITING, restStartedAt: null, queueEnteredAt: new Date(), version: { increment: 1 } } }))); }));
api.post("/queue/players/:id/check-out", requireAuth, requireMutationOrigin, route(async (request, response) => { const player = await ownedQueuePlayer(request, request.params.id); if (![QueuePlayerStatus.INACTIVE, QueuePlayerStatus.WAITING, QueuePlayerStatus.RESTING].includes(player.status)) throw conflict("PLAYER_BUSY", "Busy players cannot be checked out."); responseData(response, queuePlayerView(await db.queuePlayer.update({ where: { id: player.id }, data: { status: QueuePlayerStatus.CHECKED_OUT, checkedOutAt: new Date(), queueEnteredAt: null, version: { increment: 1 } } }))); }));
api.post("/queue/players/:id/late-penalty/waive", requireAuth, requireMutationOrigin, route(async (request, response) => { const player = await ownedQueuePlayer(request, request.params.id); assertVersion(player.version, versionFrom(request)); if (player.latePenaltyState !== LatePenaltyState.PENDING) { responseData(response, queuePlayerView(player)); return; } const updated = await db.$transaction(async (tx: any) => { const next = await tx.queuePlayer.update({ where: { id: player.id }, data: { latePenaltyState: LatePenaltyState.WAIVED, version: { increment: 1 } } }); await tx.queueWorkspace.update({ where: { queueMasterId: authUser(request).id }, data: { matchmakingRevision: { increment: 1 }, version: { increment: 1 } } }); await audit(tx, request, { action: "LATE_PENALTY_WAIVED", entityType: "QUEUE_PLAYER", entityId: player.id, reason: "Late-arrival penalty waived" }); return next; }); responseData(response, queuePlayerView(updated)); }));
api.get("/queue", requireAuth, route(async (request, response) => { const workspace = await workspaceFor(request); const settings = (await ensureWorkspace(authUser(request).id)).settings; const players = await db.queuePlayer.findMany({ where: { queueMasterId: authUser(request).id }, orderBy: [{ status: "asc" }, { queueEnteredAt: "asc" }] }); const view = (player: any) => queuePlayerView(player, settings.minimumRestMinutes); responseData(response, { serverTime: new Date(), minimumRestMinutes: settings.minimumRestMinutes, lateArrivalCutoffAt: workspace.lateArrivalCutoffAt, inactive: players.filter((p: any) => p.status === QueuePlayerStatus.INACTIVE || p.status === QueuePlayerStatus.CHECKED_OUT).map(view), waiting: players.filter((p: any) => p.status === QueuePlayerStatus.WAITING).map(view), queued: players.filter((p: any) => p.status === QueuePlayerStatus.QUEUED).map(view), playing: players.filter((p: any) => p.status === QueuePlayerStatus.PLAYING).map(view), resting: players.filter((p: any) => p.status === QueuePlayerStatus.RESTING).map(view) }); }));

api.get("/courts", requireAuth, route(async (request, response) => { responseData(response, (await db.court.findMany({ where: { queueMasterId: authUser(request).id }, orderBy: { displayOrder: "asc" } })).map(courtView)); }));
api.post("/courts", requireAuth, requireMutationOrigin, route(async (request, response) => { const body = parse(z.object({ name: courtNameSchema }), request.body); const last = await db.court.findFirst({ where: { queueMasterId: authUser(request).id }, orderBy: { displayOrder: "desc" }, select: { displayOrder: true } }); const name = body.name; const court = await db.court.create({ data: { queueMasterId: authUser(request).id, name, normalizedName: normalizeName(name), displayOrder: (last?.displayOrder ?? -1) + 1 } }); responseData(response, courtView(court), 201); }));
api.patch("/courts/:id", requireAuth, requireMutationOrigin, route(async (request, response) => { const current = await db.court.findFirst({ where: owner(request, request.params.id) }); if (!current) throw notFound("Court not found."); assertVersion(current.version, versionFrom(request)); const body = parse(z.object({ name: courtNameSchema.optional(), status: z.enum([CourtStatus.AVAILABLE, CourtStatus.CLOSED]).optional() }), request.body); if (current.status === CourtStatus.OCCUPIED && (body.name !== undefined || body.status !== undefined)) throw conflict("COURT_OCCUPIED", "Occupied courts cannot be changed while a match is playing."); const updated = await withTransactionRetry(async (tx) => { if (body.name !== undefined) await tx.match.updateMany({ where: { queueMasterId: authUser(request).id, courtId: current.id, courtNameSnapshot: null }, data: { courtIdSnapshot: current.id, courtNameSnapshot: current.name } }); return tx.court.update({ where: { id: current.id }, data: { ...(body.name !== undefined ? { name: body.name, normalizedName: normalizeName(body.name) } : {}), ...(body.status !== undefined ? { status: body.status, closedAt: body.status === CourtStatus.CLOSED ? new Date() : null } : {}), version: { increment: 1 } } }); }); responseData(response, courtView(updated)); }));
api.delete("/courts/:id", requireAuth, requireMutationOrigin, route(async (request, response) => { const current = await db.court.findFirst({ where: owner(request, request.params.id) }); if (!current) throw notFound("Court not found."); assertVersion(current.version, versionFrom(request)); if (current.status === CourtStatus.OCCUPIED || current.currentMatchId) throw conflict("COURT_OCCUPIED", "Occupied courts cannot be deleted while a match is playing."); const result = await withTransactionRetry(async (tx) => { const matches = await tx.match.findMany({ where: { queueMasterId: authUser(request).id, courtId: current.id }, select: { id: true } }); if (matches.length) await tx.match.updateMany({ where: { id: { in: matches.map((match: any) => match.id) } }, data: { courtId: null, courtIdSnapshot: current.id, courtNameSnapshot: current.name } }); await tx.court.delete({ where: { id: current.id } }); await audit(tx, request, { action: "COURT_DELETED", entityType: "COURT", entityId: current.id, before: current, after: { courtId: current.id, name: current.name, preservedHistoryMatchCount: matches.length } }); return { deletedCourtIds: [current.id], deletedCount: 1, preservedHistoryMatchCount: matches.length }; }); responseData(response, result); }));
api.post("/courts/delete", requireAuth, requireMutationOrigin, route(async (request, response) => { const body = parse(z.object({ statuses: z.array(z.enum([CourtStatus.AVAILABLE, CourtStatus.CLOSED])).min(1).max(2) }), request.body); const statuses = [...new Set(body.statuses)]; const result = await withTransactionRetry(async (tx) => { const courts = await tx.court.findMany({ where: { queueMasterId: authUser(request).id, status: { in: statuses }, OR: [{ currentMatchId: null }, { currentMatchId: { isSet: false } }] }, select: { id: true, name: true } }); const deletedCourtIds = courts.map((court: any) => court.id); let preservedHistoryMatchCount = 0; for (const court of courts) { const matches = await tx.match.findMany({ where: { queueMasterId: authUser(request).id, courtId: court.id }, select: { id: true } }); if (matches.length) { preservedHistoryMatchCount += matches.length; await tx.match.updateMany({ where: { id: { in: matches.map((match: any) => match.id) } }, data: { courtId: null, courtIdSnapshot: court.id, courtNameSnapshot: court.name } }); } } if (deletedCourtIds.length) await tx.court.deleteMany({ where: { queueMasterId: authUser(request).id, id: { in: deletedCourtIds }, status: { in: statuses }, OR: [{ currentMatchId: null }, { currentMatchId: { isSet: false } }] } }); if (deletedCourtIds.length) await audit(tx, request, { action: "COURTS_DELETED", entityType: "COURT", entityId: authUser(request).id, before: courts, after: { deletedCourtIds, statuses, preservedHistoryMatchCount } }); return { deletedCourtIds, deletedCount: deletedCourtIds.length, preservedHistoryMatchCount }; }); responseData(response, result); }));

api.post("/suggestions", requireAuth, route(async (request, response) => { const body = parse(z.object({ mode: z.enum(modeValues), strengthGap: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(), excludeKeys: z.array(z.string()).max(50).default([]) }), request.body); const workspace = await workspaceFor(request); const settings = (await ensureWorkspace(authUser(request).id)).settings; const players = await db.queuePlayer.findMany({ where: { queueMasterId: authUser(request).id } }); const history = await historyMaps(authUser(request).id); const strengthGap = body.mode === MatchmakingMode.BALANCED ? body.strengthGap ?? 1 : undefined; const options: MatchmakingOptions = { strengthGap, minimumRestMinutes: settings.minimumRestMinutes, now: new Date() }; const input: MatchPlayer[] = players.map((p: any) => ({ id: p.id, displayName: p.displayNameSnapshot, gender: p.genderSnapshot, skillWeight: p.skillWeightSnapshot, skillLevel: p.skillLevelSnapshot, status: p.status, gamesPlayed: p.matchesPlayed, queueEnteredAt: p.queueEnteredAt, lastMatchEndedAt: p.lastMatchEndedAt, manualPriority: p.manualPriority, latePenaltyState: p.latePenaltyState, latePenaltyAppliedAt: p.latePenaltyAppliedAt })); let suggestion = suggestMatch(input, body.mode as MatchmakingMode, history, body.excludeKeys, options); let cycleRestarted = false; if (!suggestion && body.excludeKeys.length) { suggestion = suggestMatch(input, body.mode as MatchmakingMode, history, [], options); cycleRestarted = Boolean(suggestion); } if (!suggestion) { const now = Date.now(); const waiting = players.filter((player: any) => player.status === QueuePlayerStatus.WAITING); const ready = waiting.filter((player: any) => restEligibleAt(player.lastMatchEndedAt, settings.minimumRestMinutes, now).getTime() <= now); const nextEligibleAt = waiting.map((player: any) => restEligibleAt(player.lastMatchEndedAt, settings.minimumRestMinutes, now).getTime()).filter((value: number) => value > now).sort((a: number, b: number) => a - b)[0]; const restBlocked = waiting.length >= 4 && ready.length < 4 && settings.minimumRestMinutes > 0; const message = restBlocked ? "Some players are still completing their required rest period." : body.mode === MatchmakingMode.BALANCED ? `No balanced lineup is available with player and team strength gaps of ${strengthGap} or less. Wait for more eligible players or use Manual mode.` : "No eligible group satisfies this mode."; responseData(response, { suggestion: null, cycleRestarted: false, noMatch: { code: restBlocked ? "REST_REQUIRED" : "NO_VALID_GROUP", message, nextEligibleAt: nextEligibleAt ? new Date(nextEligibleAt) : null } }); return; } const expiresAt = Date.now() + 300_000; const token = signSuggestion({ queueMasterId: authUser(request).id, revision: workspace.matchmakingRevision, mode: body.mode, strengthGap, key: suggestion.key, teamA: suggestion.teamA.map((p) => p.id), teamB: suggestion.teamB.map((p) => p.id), expiresAt }); const viewPlayer = (p: MatchPlayer) => ({ id: p.id, displayName: p.displayName, gender: p.gender, skillLevel: p.skillLevel, gamesPlayed: p.gamesPlayed, lastMatchEndedAt: p.lastMatchEndedAt, restEligibleAt: restEligibleAt(p.lastMatchEndedAt, settings.minimumRestMinutes), latePenaltyState: p.latePenaltyState ?? null }); responseData(response, { cycleRestarted, suggestion: { token, expiresAt, lateArrivalCutoffAt: workspace.lateArrivalCutoffAt, strengthGap, ...suggestion, teamA: suggestion.teamA.map(viewPlayer), teamB: suggestion.teamB.map(viewPlayer), explanation: { ...suggestion.explanation, algorithmVersion: MATCHMAKING_ALGORITHM, cycleRestarted } } }); }));

async function createMatchLegacy(request: Request, body: { teamA: string[]; teamB: string[]; courtId?: string; suggestionToken?: string }) { const all = [...body.teamA, ...body.teamB]; if (![1, 2].includes(body.teamA.length) || body.teamA.length !== body.teamB.length || new Set(all).size !== all.length) throw badRequest("Choose one player per team for singles or two per team for doubles."); const players = await db.queuePlayer.findMany({ where: { id: { in: all }, queueMasterId: authUser(request).id } }); if (players.length !== all.length || players.some((p: any) => p.status !== QueuePlayerStatus.WAITING || p.currentMatchId)) throw conflict("PLAYER_BUSY", "One or more selected players are no longer waiting."); const settings = (await ensureWorkspace(authUser(request).id)).settings; const court = body.courtId ? await db.court.findFirst({ where: owner(request, body.courtId) }) : null; if (body.courtId && (!court || court.status !== CourtStatus.AVAILABLE || court.currentMatchId)) throw conflict("COURT_NOT_AVAILABLE", "The selected court is not available."); const match = await db.$transaction(async (tx: any) => { const created = await tx.match.create({ data: { queueMasterId: authUser(request).id, courtId: court?.id ?? null, courtIdSnapshot: court?.id ?? null, courtNameSnapshot: court?.name ?? null, status: court ? MatchStatus.IN_PROGRESS : MatchStatus.QUEUED, source: body.suggestionToken ? MatchSource.AUTOMATIC : MatchSource.MANUAL, algorithmVersion: body.suggestionToken ? MATCHMAKING_ALGORITHM : null, pointsToWin: settings.pointsToWin, winBy: settings.winBy, scoreCap: settings.scoreCap, bestOf: settings.bestOf, startedAt: court ? new Date() : null, participants: { create: all.map((id) => ({ queuePlayerId: id, priorQueueEnteredAt: players.find((p: any) => p.id === id)?.queueEnteredAt ?? null, team: body.teamA.includes(id) ? TeamSide.A : TeamSide.B, teamSlot: body.teamA.includes(id) ? body.teamA.indexOf(id) + 1 : body.teamB.indexOf(id) + 1 })) } } }); await tx.queuePlayer.updateMany({ where: { id: { in: all }, status: QueuePlayerStatus.WAITING }, data: { status: court ? QueuePlayerStatus.PLAYING : QueuePlayerStatus.QUEUED, currentMatchId: created.id, queueEnteredAt: null, manualPriority: 0, priorityReason: null, version: { increment: 1 } } }); if (court) await tx.court.update({ where: { id: court.id }, data: { status: CourtStatus.OCCUPIED, currentMatchId: created.id, version: { increment: 1 } } }); await tx.queueWorkspace.update({ where: { queueMasterId: authUser(request).id }, data: { matchmakingRevision: { increment: 1 }, version: { increment: 1 } } }); return created; }); return db.match.findUnique({ where: { id: match.id }, include: { participants: { include: { queuePlayer: true } }, court: true } }); }
void createMatchLegacy;

async function createMatch(request: Request, body: { teamA: string[]; teamB: string[]; courtId?: string; suggestionToken?: string; suggestionAdjusted?: boolean; suggestionPayload?: Record<string, unknown> }) {
  const all = [...body.teamA, ...body.teamB];
  if (![1, 2].includes(body.teamA.length) || body.teamA.length !== body.teamB.length || new Set(all).size !== all.length) throw badRequest("Choose one player per team for singles or doubles.");
  const queueMasterId = authUser(request).id;
  const manualQueue = !body.suggestionToken && !body.courtId;
  const settings = (await ensureWorkspace(queueMasterId)).settings;
  const matchId = await withTransactionRetry(async (tx) => {
    const players = await tx.queuePlayer.findMany({ where: { id: { in: all }, queueMasterId } });
    const allowed = manualQueue ? [QueuePlayerStatus.WAITING, QueuePlayerStatus.QUEUED, QueuePlayerStatus.PLAYING, QueuePlayerStatus.RESTING] : [QueuePlayerStatus.WAITING];
    if (players.length !== all.length || players.some((player: any) => !allowed.includes(player.status))) throw conflict("PLAYER_BUSY", manualQueue ? "Selected players must be waiting, queued, or playing." : "One or more selected players are no longer waiting.");
    if (body.courtId || body.suggestionToken) assertPlayersRestEligible(players, settings.minimumRestMinutes);
    const court = body.courtId ? await tx.court.findFirst({ where: owner(request, body.courtId) }) : null;
    if (body.courtId && (!court || court.status !== CourtStatus.AVAILABLE || court.currentMatchId)) throw conflict("COURT_NOT_AVAILABLE", "The selected court is not available.");
    const status = court ? MatchStatus.IN_PROGRESS : MatchStatus.QUEUED;
    const source = body.suggestionToken ? body.suggestionAdjusted ? MatchSource.MANUAL_ADJUSTED : MatchSource.AUTOMATIC : MatchSource.MANUAL;
    const suggestionExplanation = body.suggestionPayload ? { algorithmVersion: MATCHMAKING_ALGORITHM, strengthGap: body.suggestionPayload.strengthGap ?? null, mode: body.suggestionPayload.mode ?? null, adjusted: Boolean(body.suggestionAdjusted), rest: { minimumRestMinutes: settings.minimumRestMinutes } } : null;
    const created = await tx.match.create({ data: { queueMasterId, courtId: court?.id ?? null, courtIdSnapshot: court?.id ?? null, courtNameSnapshot: court?.name ?? null, status, source, matchmakingMode: body.suggestionPayload?.mode as MatchmakingMode | undefined ?? null, algorithmVersion: body.suggestionToken ? MATCHMAKING_ALGORITHM : null, suggestionKey: typeof body.suggestionPayload?.key === "string" ? body.suggestionPayload.key : null, suggestionExplanation, pointsToWin: settings.pointsToWin, winBy: settings.winBy, scoreCap: settings.scoreCap, bestOf: settings.bestOf, startedAt: court ? new Date() : null, participants: { create: all.map((id) => ({ queuePlayerId: id, priorQueueEnteredAt: players.find((player: any) => player.id === id)?.queueEnteredAt ?? null, team: body.teamA.includes(id) ? TeamSide.A : TeamSide.B, teamSlot: body.teamA.includes(id) ? body.teamA.indexOf(id) + 1 : body.teamB.indexOf(id) + 1 })) } } });
    if (court) {
      const claimedCourt = await tx.court.updateMany({ where: { id: court.id, status: CourtStatus.AVAILABLE, OR: [{ currentMatchId: null }, { currentMatchId: { isSet: false } }] }, data: { status: CourtStatus.OCCUPIED, currentMatchId: created.id, version: { increment: 1 } } });
      if (claimedCourt.count !== 1) throw conflict("COURT_NOT_AVAILABLE", "The selected court is no longer available.");
    }
    await reconcileQueuePlayers(tx, queueMasterId, all, new Date(), new Map(all.map((id) => [id, { manualPriority: 0, priorityReason: null }])));
    if (court) await serveLatePenalties(tx, queueMasterId, all);
    await tx.queueWorkspace.update({ where: { queueMasterId }, data: { matchmakingRevision: { increment: 1 }, version: { increment: 1 } } });
    return created.id;
  });
  return db.match.findUnique({ where: { id: matchId }, include: { participants: { include: { queuePlayer: true } }, court: true } });
}

api.post("/matches/:id/start", requireAuth, requireMutationOrigin, route(async (request, response) => {
  const body = parse(z.object({ courtId: idSchema }), request.body);
  const queueMasterId = authUser(request).id;
  const settings = (await ensureWorkspace(queueMasterId)).settings;
  const startedId = await withTransactionRetry(async (tx) => {
    const match = await tx.match.findFirst({ where: { id: String(request.params.id), queueMasterId }, include: { participants: true } });
    if (!match) throw notFound("Match not found.");
    if (match.status !== MatchStatus.QUEUED) throw conflict("MATCH_NOT_QUEUED", "Only queued matches can start.");
    const playerIds = match.participants.map((participant: any) => participant.queuePlayerId);
    const activeOverlap = await tx.match.findFirst({ where: { queueMasterId, status: MatchStatus.IN_PROGRESS, participants: { some: { queuePlayerId: { in: playerIds } } } }, select: { id: true } });
    if (activeOverlap) throw conflict("MATCH_NOT_READY", "One or more players are still playing another match.");
    const players = await tx.queuePlayer.findMany({ where: { queueMasterId, id: { in: playerIds } } });
    assertPlayersRestEligible(players, settings.minimumRestMinutes);
    const court = await tx.court.findFirst({ where: { id: body.courtId, queueMasterId, status: CourtStatus.AVAILABLE, OR: [{ currentMatchId: null }, { currentMatchId: { isSet: false } }] } });
    if (!court) throw conflict("COURT_NOT_AVAILABLE", "The selected court is no longer available.");
    const claimedCourt = await tx.court.updateMany({ where: { id: court.id, status: CourtStatus.AVAILABLE, OR: [{ currentMatchId: null }, { currentMatchId: { isSet: false } }] }, data: { status: CourtStatus.OCCUPIED, currentMatchId: match.id, version: { increment: 1 } } });
    if (claimedCourt.count !== 1) throw conflict("COURT_NOT_AVAILABLE", "The selected court is no longer available.");
    const claimedPlayers = await tx.queuePlayer.updateMany({ where: { id: { in: playerIds }, queueMasterId, status: { in: [QueuePlayerStatus.WAITING, QueuePlayerStatus.QUEUED] } }, data: { status: QueuePlayerStatus.PLAYING, currentMatchId: match.id, queueEnteredAt: null, version: { increment: 1 } } });
    if (claimedPlayers.count !== playerIds.length) throw conflict("PLAYER_LOCK_CONFLICT", "One or more players changed before the queued match could start.");
    await serveLatePenalties(tx, queueMasterId, playerIds);
    const updated = await tx.match.updateMany({ where: { id: match.id, status: MatchStatus.QUEUED }, data: { courtId: court.id, courtIdSnapshot: court.id, courtNameSnapshot: court.name, status: MatchStatus.IN_PROGRESS, startedAt: new Date(), version: { increment: 1 } } });
    if (updated.count !== 1) throw conflict("MATCH_NOT_QUEUED", "The queued match changed before it could start.");
    return match.id;
  });
  responseData(response, matchView(await db.match.findUnique({ where: { id: startedId }, include: { participants: { include: { queuePlayer: true } }, court: true } })));
}));

api.post("/matches/:id/cancel", requireAuth, requireMutationOrigin, route(async (request, response) => {
  const queueMasterId = authUser(request).id;
  const discarded = await withTransactionRetry(async (tx) => {
    const match = await tx.match.findFirst({ where: { id: String(request.params.id), queueMasterId }, include: { participants: true } });
    if (!match) throw notFound("Match not found.");
    if (match.status !== MatchStatus.QUEUED && match.status !== MatchStatus.IN_PROGRESS) throw conflict("MATCH_NOT_OPEN", "Only queued or playing matches can be discarded.");
    if (match.courtId) await tx.court.updateMany({ where: { id: match.courtId, currentMatchId: match.id }, data: { currentMatchId: null, status: CourtStatus.AVAILABLE, version: { increment: 1 } } });
    const claimed = await tx.match.updateMany({ where: { id: match.id, status: { in: [MatchStatus.QUEUED, MatchStatus.IN_PROGRESS] } }, data: { status: MatchStatus.CANCELLED, cancelledAt: new Date(), cancellationReason: "Discarded by Queue Master", version: { increment: 1 } } });
    if (claimed.count !== 1) throw conflict("MATCH_NOT_OPEN", "The match changed before it could be discarded.");
    await reconcileQueuePlayers(tx, queueMasterId, match.participants.map((participant: any) => participant.queuePlayerId));
    return tx.match.findUnique({ where: { id: match.id }, include: { participants: { include: { queuePlayer: true } }, court: true } });
  });
  responseData(response, matchView(discarded));
}));

api.post("/matches/:id/complete", requireAuth, requireMutationOrigin, route(async (request, response) => {
  const body = parse(z.object({ games: z.array(z.object({ teamAScore: z.number().int(), teamBScore: z.number().int() })).min(1).max(3) }), request.body);
  const queueMasterId = authUser(request).id;
  const match = await ownedMatch(request, request.params.id);
  if (match.status !== MatchStatus.IN_PROGRESS) throw conflict("MATCH_NOT_IN_PROGRESS", "Only active matches can be completed.");
  const validated = validateScores(body.games as ScoreInput[], scoreSettings(match));
  const winnerTeam = validated.filter((game) => game.winnerTeam === TeamSide.A).length > validated.filter((game) => game.winnerTeam === TeamSide.B).length ? TeamSide.A : TeamSide.B;
  const points = validated.reduce((sum, game) => ({ a: sum.a + game.teamAScore, b: sum.b + game.teamBScore }), { a: 0, b: 0 });
  const completed = await withTransactionRetry(async (tx) => {
    const claimed = await tx.match.updateMany({ where: { id: match.id, queueMasterId, status: MatchStatus.IN_PROGRESS }, data: { version: { increment: 1 } } });
    if (claimed.count !== 1) throw conflict("MATCH_NOT_IN_PROGRESS", "This match changed before its result could be recorded.");
    const completedAt = new Date();
    const revision = await tx.matchScoreRevision.create({ data: { matchId: match.id, revisionNumber: 1, winnerTeam, createdByQueueMasterId: queueMasterId, games: { create: validated.map((game, index) => ({ gameNumber: index + 1, teamAScore: game.teamAScore, teamBScore: game.teamBScore, winnerTeam: game.winnerTeam })) } } });
    const updated = await tx.match.update({ where: { id: match.id }, data: { status: MatchStatus.COMPLETED, completedAt, winnerTeam, currentRevisionId: revision.id, version: { increment: 1 } } });
    if (match.courtId) await tx.court.updateMany({ where: { id: match.courtId, currentMatchId: match.id }, data: { status: CourtStatus.AVAILABLE, currentMatchId: null, version: { increment: 1 } } });
    const extras = new Map<string, QueuePlayerExtra>();
    for (const participant of match.participants) {
      const won = participant.team === winnerTeam;
      extras.set(participant.queuePlayerId, { lastMatchEndedAt: completedAt, matchesPlayed: { increment: 1 }, wins: { increment: won ? 1 : 0 }, losses: { increment: won ? 0 : 1 }, pointsFor: { increment: participant.team === TeamSide.A ? points.a : points.b }, pointsAgainst: { increment: participant.team === TeamSide.A ? points.b : points.a } });
    }
    await reconcileQueuePlayers(tx, queueMasterId, match.participants.map((participant: any) => participant.queuePlayerId), completedAt, extras);
    return updated;
  });
  responseData(response, matchView(await db.match.findUnique({ where: { id: completed.id }, include: { participants: { include: { queuePlayer: true } }, court: true } })));
}));

api.post("/matches", requireAuth, requireMutationOrigin, route(async (request, response) => { const body = parse(z.object({ teamA: z.array(idSchema), teamB: z.array(idSchema), courtId: idSchema.optional(), suggestionToken: z.string().min(20).optional(), suggestionAdjusted: z.boolean().optional() }), request.body); const suggestionPayload = body.suggestionToken ? await validateSuggestionRequest(request, body.suggestionToken, body.teamA, body.teamB, Boolean(body.suggestionAdjusted)) : undefined; responseData(response, matchView(await createMatch(request, { ...body, suggestionPayload })), 201); }));
api.get("/matches", requireAuth, route(async (request, response) => { const matches = await db.match.findMany({ where: { queueMasterId: authUser(request).id, status: { in: [MatchStatus.QUEUED, MatchStatus.IN_PROGRESS] } }, orderBy: [{ queuedAt: "asc" }, { id: "asc" }], include: { participants: { include: { queuePlayer: true } }, court: true } }); responseData(response, matches.map(matchView)); }));
api.post("/matches/start-suggestion", requireAuth, requireMutationOrigin, route(async (request, response) => { const body = parse(z.object({ teamA: z.array(idSchema).length(2), teamB: z.array(idSchema).length(2), courtId: idSchema, suggestionToken: z.string().min(20) }), request.body); const suggestionPayload = await validateSuggestionRequest(request, body.suggestionToken, body.teamA, body.teamB, false); responseData(response, matchView(await createMatch(request, { ...body, suggestionToken: body.suggestionToken, suggestionPayload })), 201); }));
api.get("/matches", requireAuth, route(async (request, response) => { const matches = await db.match.findMany({ where: { queueMasterId: authUser(request).id }, orderBy: { queuedAt: "desc" }, take: 100, include: { participants: { include: { queuePlayer: true } }, court: true } }); responseData(response, matches.map(matchView)); }));
api.post("/matches/:id/start", requireAuth, requireMutationOrigin, route(async (request, response) => { const body = parse(z.object({ courtId: idSchema }), request.body); const match = await ownedMatch(request, request.params.id); if (match.status !== MatchStatus.QUEUED) throw conflict("MATCH_NOT_QUEUED", "Only queued matches can start."); const started = await db.$transaction(async (tx: any) => { const court = await tx.court.findFirst({ where: { id: body.courtId, queueMasterId: authUser(request).id, status: CourtStatus.AVAILABLE, OR: [{ currentMatchId: null }, { currentMatchId: { isSet: false } }] } }); if (!court) throw conflict("COURT_NOT_AVAILABLE", "The selected court is no longer available."); const claimedCourt = await tx.court.updateMany({ where: { id: court.id, status: CourtStatus.AVAILABLE, OR: [{ currentMatchId: null }, { currentMatchId: { isSet: false } }] }, data: { status: CourtStatus.OCCUPIED, currentMatchId: match.id, version: { increment: 1 } } }); if (claimedCourt.count !== 1) throw conflict("COURT_NOT_AVAILABLE", "The selected court is no longer available."); const players = await tx.queuePlayer.updateMany({ where: { id: { in: match.participants.map((p: any) => p.queuePlayerId) }, currentMatchId: match.id, status: QueuePlayerStatus.QUEUED }, data: { status: QueuePlayerStatus.PLAYING, version: { increment: 1 } } }); if (players.count !== match.participants.length) throw conflict("PLAYER_LOCK_CONFLICT", "The player lineup changed before start."); return tx.match.update({ where: { id: match.id }, data: { courtId: court.id, courtIdSnapshot: court.id, courtNameSnapshot: court.name, status: MatchStatus.IN_PROGRESS, startedAt: new Date(), version: { increment: 1 } } }); }); responseData(response, matchView(await db.match.findUnique({ where: { id: started.id }, include: { participants: { include: { queuePlayer: true } }, court: true } }))); }));
api.post("/matches/:id/cancel", requireAuth, requireMutationOrigin, route(async (request, response) => { const match = await ownedMatch(request, request.params.id); if (![MatchStatus.QUEUED, MatchStatus.IN_PROGRESS].includes(match.status)) throw conflict("MATCH_NOT_OPEN", "Only queued or playing matches can be discarded."); const discarded = await db.$transaction(async (tx: any) => { if (match.courtId) await tx.court.updateMany({ where: { id: match.courtId, currentMatchId: match.id }, data: { currentMatchId: null, status: CourtStatus.AVAILABLE, version: { increment: 1 } } }); await tx.queuePlayer.updateMany({ where: { currentMatchId: match.id }, data: { currentMatchId: null, status: QueuePlayerStatus.WAITING, queueEnteredAt: new Date(), version: { increment: 1 } } }); return tx.match.update({ where: { id: match.id }, data: { status: MatchStatus.CANCELLED, cancelledAt: new Date(), cancellationReason: "Discarded by Queue Master", version: { increment: 1 } } }); }); responseData(response, matchView(await db.match.findUnique({ where: { id: discarded.id }, include: { participants: { include: { queuePlayer: true } }, court: true } }))); }));
api.post("/matches/:id/complete", requireAuth, requireMutationOrigin, route(async (request, response) => { const body = parse(z.object({ games: z.array(z.object({ teamAScore: z.number().int(), teamBScore: z.number().int() })).min(1).max(3) }), request.body); const match = await ownedMatch(request, request.params.id); if (match.status !== MatchStatus.IN_PROGRESS) throw conflict("MATCH_NOT_IN_PROGRESS", "Only active matches can be completed."); const validated = validateScores(body.games as ScoreInput[], scoreSettings(match)); const winnerTeam = validated.filter((game) => game.winnerTeam === TeamSide.A).length > validated.filter((game) => game.winnerTeam === TeamSide.B).length ? TeamSide.A : TeamSide.B; const points = validated.reduce((sum, game) => ({ a: sum.a + game.teamAScore, b: sum.b + game.teamBScore }), { a: 0, b: 0 }); const completed = await db.$transaction(async (tx: any) => { const claimed = await tx.match.updateMany({ where: { id: match.id, status: MatchStatus.IN_PROGRESS }, data: { version: { increment: 1 } } }); if (claimed.count !== 1) throw conflict("MATCH_NOT_IN_PROGRESS", "This match changed before its result could be recorded."); const revision = await tx.matchScoreRevision.create({ data: { matchId: match.id, revisionNumber: 1, winnerTeam, createdByQueueMasterId: authUser(request).id, games: { create: validated.map((game, index) => ({ gameNumber: index + 1, teamAScore: game.teamAScore, teamBScore: game.teamBScore, winnerTeam: game.winnerTeam })) } } }); const updated = await tx.match.update({ where: { id: match.id }, data: { status: MatchStatus.COMPLETED, completedAt: new Date(), winnerTeam, currentRevisionId: revision.id, version: { increment: 1 } } }); if (match.courtId) await tx.court.update({ where: { id: match.courtId }, data: { status: CourtStatus.AVAILABLE, currentMatchId: null, version: { increment: 1 } } }); for (const participant of match.participants) { const won = participant.team === winnerTeam; await tx.queuePlayer.update({ where: { id: participant.queuePlayerId }, data: { status: QueuePlayerStatus.WAITING, currentMatchId: null, queueEnteredAt: new Date(), lastMatchEndedAt: new Date(), matchesPlayed: { increment: 1 }, wins: { increment: won ? 1 : 0 }, losses: { increment: won ? 0 : 1 }, pointsFor: { increment: participant.team === TeamSide.A ? points.a : points.b }, pointsAgainst: { increment: participant.team === TeamSide.A ? points.b : points.a }, version: { increment: 1 } } }); } return updated; }); responseData(response, matchView(await db.match.findUnique({ where: { id: completed.id }, include: { participants: { include: { queuePlayer: true } }, court: true } }))); }));
api.get("/history", requireAuth, route(async (request, response) => { const query = parse(historyQuerySchema, request.query); const matches = await matchHistoryFor(authUser(request).id); const search = query.search.toLowerCase(); const rows = matches.map((match: any) => historyMatchView(match)).filter((match: any) => !search || match.participants.some((p: any) => String(p.displayName).toLowerCase().includes(search))); responseData(response, pageResult(rows, query.page, query.pageSize)); }));
function rankingRow(row: any, index: number) {
  return { rank: index + 1, queuePlayerId: row.id, player: row.displayNameSnapshot, playerId: row.playerId, gender: row.genderSnapshot, skillLevel: row.skillLevelSnapshot, matchesPlayed: row.matchesPlayed, wins: row.wins, losses: row.losses, winRateBasisPoints: row.matchesPlayed ? Math.floor((row.wins * 10000) / row.matchesPlayed) : 0, pointsFor: row.pointsFor, pointsAgainst: row.pointsAgainst, pointDifferential: row.pointsFor - row.pointsAgainst };
}
async function rankingRows(queueMasterId: string, database = db) {
  return database.queuePlayer.findMany({ where: { queueMasterId }, orderBy: [{ wins: "desc" }, { matchesPlayed: "desc" }, { normalizedNameSnapshot: "asc" }] });
}
async function publicRankingSnapshot(queueMasterId: string, publicationId: string, capturedAt = new Date(), database = db) {
  const rows = await rankingRows(queueMasterId, database);
  const matches = await database.match.findMany({ where: { queueMasterId, status: MatchStatus.COMPLETED }, include: { participants: { include: { queuePlayer: true } }, scoreRevisions: { include: { games: true } } }, orderBy: { completedAt: "desc" }, take: PUBLIC_RANKING_MATCH_LIMIT });
  return publicRankingSnapshotFromRecords({ publicationId, capturedAt, rows, matches });
}
function publicPublicationState(publication: any) {
  return publication.revokedAt || !publication.enabled ? "REVOKED" : publication.finalizedAt ? "FINAL" : "LIVE";
}
function publicPublicationView(publication: any, includeToken = false) {
  return { id: publication.id, sessionStartedAt: publication.sessionStartedAt, sessionEndedAt: publication.sessionEndedAt, state: publicPublicationState(publication), publishedAt: publication.publishedAt, finalizedAt: publication.finalizedAt, revokedAt: publication.revokedAt, version: publication.version, ...(includeToken && publication.enabled && !publication.revokedAt ? { token: publication.publicToken } : {}) };
}
async function finalizePublicRankingPublication(tx: any, queueMasterId: string, workspace: any, endedAt: Date) {
  const publication = await tx.publicRankingPublication.findFirst({ where: { queueMasterId, sessionStartedAt: workspace.startedAt } });
  if (!publication || publication.finalizedAt) return publication;
  const finalSnapshot = await publicRankingSnapshot(queueMasterId, publication.id, endedAt, tx);
  const finalized = await tx.publicRankingPublication.update({ where: { id: publication.id }, data: { sessionEndedAt: endedAt, finalizedAt: endedAt, finalSnapshot, version: { increment: 1 } } });
  await tx.auditLog.create({ data: { queueMasterId, action: "PUBLIC_RANKINGS_FINALIZED", entityType: "PUBLIC_RANKING", entityId: publication.id, reason: "Public rankings finalized with the session", afterJson: { sessionEndedAt: endedAt.toISOString() }, requestId: `system:public-ranking:${endedAt.getTime()}` } });
  return finalized;
}
api.get("/rankings", requireAuth, route(async (request, response) => { const rows = await rankingRows(authUser(request).id); responseData(response, rows.map(rankingRow)); }));
api.get("/workspace/public-rankings", requireAuth, route(async (request, response) => {
  const queueMasterId = authUser(request).id;
  const workspace = await workspaceFor(request);
  const publications = await db.publicRankingPublication.findMany({ where: { queueMasterId, ...activePublicRankingWhere() }, orderBy: { sessionStartedAt: "desc" } });
  const current = publications.find((publication: any) => publication.sessionStartedAt.getTime() === workspace.startedAt.getTime());
  responseData(response, { current: current ? publicPublicationView(current, true) : null, archives: publications.filter((publication: any) => publication.id !== current?.id).map((publication: any) => publicPublicationView(publication, true)) });
}));
api.post("/workspace/public-rankings/publish", requireAuth, requireMutationOrigin, route(async (request, response) => {
  const queueMasterId = authUser(request).id;
  const workspace = await workspaceFor(request);
  assertVersion(workspace.version, versionFrom(request));
  const result = await withTransactionRetry(async (tx) => {
    const existing = await tx.publicRankingPublication.findFirst({ where: { queueMasterId, sessionStartedAt: workspace.startedAt } });
    if (existing?.enabled && !existing.revokedAt) return existing;
    const now = new Date();
    const publication = existing
      ? await tx.publicRankingPublication.update({ where: { id: existing.id }, data: { publicToken: randomUUID(), enabled: true, publishedAt: now, revokedAt: null, version: { increment: 1 } } })
      : await tx.publicRankingPublication.create({ data: { queueMasterId, sessionStartedAt: workspace.startedAt, publicToken: randomUUID(), enabled: true, publishedAt: now, revokedAt: null } });
    if (workspace.endedAt && !publication.finalizedAt) {
      const finalSnapshot = await publicRankingSnapshot(queueMasterId, publication.id, workspace.endedAt, tx);
      const finalized = await tx.publicRankingPublication.update({ where: { id: publication.id }, data: { sessionEndedAt: workspace.endedAt, finalizedAt: workspace.endedAt, finalSnapshot, version: { increment: 1 } } });
      await tx.auditLog.create({ data: { queueMasterId, action: existing ? "PUBLIC_RANKINGS_REPUBLISHED" : "PUBLIC_RANKINGS_PUBLISHED", entityType: "PUBLIC_RANKING", entityId: publication.id, reason: "Queue Master published final session rankings", afterJson: { sessionStartedAt: workspace.startedAt.toISOString(), finalizedAt: workspace.endedAt.toISOString() }, requestId: String(request.id ?? randomUUID()) } });
      return finalized;
    }
    await audit(tx, request, { action: existing ? "PUBLIC_RANKINGS_REPUBLISHED" : "PUBLIC_RANKINGS_PUBLISHED", entityType: "PUBLIC_RANKING", entityId: publication.id, reason: existing ? "Public rankings link rotated by Queue Master" : "Queue Master published rankings for this queue session", after: { sessionStartedAt: workspace.startedAt, publishedAt: publication.publishedAt } });
    return publication;
  });
  responseData(response, publicPublicationView(result, true), 201);
}));
api.post("/workspace/public-rankings/:id/revoke", requireAuth, requireMutationOrigin, route(async (request, response) => {
  const queueMasterId = authUser(request).id;
  const publication = await db.publicRankingPublication.findFirst({ where: { id: String(request.params.id), queueMasterId } });
  if (!publication) throw notFound("Public rankings publication not found.");
  assertVersion(publication.version, versionFrom(request));
  const revokedAt = new Date();
  const updated = await withTransactionRetry(async (tx) => {
    const claimed = await tx.publicRankingPublication.updateMany({ where: { id: publication.id, queueMasterId, version: publication.version }, data: { enabled: false, revokedAt, version: { increment: 1 } } });
    if (claimed.count !== 1) throw conflict("VERSION_CONFLICT", "The public rankings link changed on another device.");
    await audit(tx, request, { action: "PUBLIC_RANKINGS_REVOKED", entityType: "PUBLIC_RANKING", entityId: publication.id, reason: "Queue Master revoked the public rankings link", before: { enabled: publication.enabled, revokedAt: publication.revokedAt }, after: { enabled: false, revokedAt } });
    return tx.publicRankingPublication.findUnique({ where: { id: publication.id } });
  });
  responseData(response, publicPublicationView(updated));
}));
api.get("/public/rankings/:token", rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }), route(async (request, response) => {
  const tokenValue = String(request.params.token);
  if (!idSchema.safeParse(tokenValue).success) throw notFound("Public rankings are not available.");
  const token = tokenValue;
  const publication = await db.publicRankingPublication.findFirst({ where: { publicToken: token, ...activePublicRankingWhere() } });
  if (!publication) throw notFound("Public rankings are not available.");
  response.setHeader("Cache-Control", "no-store");
  if (publication.finalizedAt) {
    if (!publication.finalSnapshot || typeof publication.finalSnapshot !== "object") throw notFound("Public rankings are not available.");
    const snapshot = publication.finalSnapshot as { capturedAt: string; rankings: unknown[]; matches?: unknown[]; schemaVersion?: number };
    responseData(response, { sessionStartedAt: publication.sessionStartedAt, sessionEndedAt: publication.sessionEndedAt, state: "FINAL", serverTime: new Date().toISOString(), lastUpdatedAt: snapshot.capturedAt, historyAvailable: isPublicRankingSnapshot(snapshot), rankings: snapshot.rankings });
    return;
  }
  const workspace = await db.queueWorkspace.findUnique({ where: { queueMasterId: publication.queueMasterId } });
  if (!workspace || workspace.startedAt.getTime() !== publication.sessionStartedAt.getTime()) throw notFound("Public rankings are not available.");
  const rows = await rankingRows(publication.queueMasterId);
  const updatedAt = rows.reduce((latest: Date, row: any) => row.updatedAt > latest ? row.updatedAt : latest, workspace.updatedAt);
  responseData(response, { sessionStartedAt: publication.sessionStartedAt, sessionEndedAt: workspace.endedAt, state: workspace.endedAt ? "FINAL" : "LIVE", serverTime: new Date().toISOString(), lastUpdatedAt: updatedAt, historyAvailable: true, rankings: rows.map((row: any, index: number) => ({ rank: index + 1, playerKey: publicPlayerKey(publication.id, row.id), player: row.displayNameSnapshot, matchesPlayed: row.matchesPlayed, wins: row.wins, losses: row.losses, winRateBasisPoints: row.matchesPlayed ? Math.floor((row.wins * 10000) / row.matchesPlayed) : 0, pointsFor: row.pointsFor, pointsAgainst: row.pointsAgainst, pointDifferential: row.pointsFor - row.pointsAgainst })) });
}));
api.get("/public/rankings/:token/players/:playerKey/history", rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }), route(async (request, response) => {
  const tokenValue = String(request.params.token);
  const playerKey = String(request.params.playerKey);
  if (!idSchema.safeParse(tokenValue).success || !playerKey) throw notFound("Public rankings are not available.");
  const publication = await db.publicRankingPublication.findFirst({ where: { publicToken: tokenValue, ...activePublicRankingWhere() } });
  if (!publication) throw notFound("Public rankings are not available.");
  response.setHeader("Cache-Control", "no-store");
  if (publication.finalizedAt) {
    if (!publication.finalSnapshot || typeof publication.finalSnapshot !== "object") throw notFound("Public rankings are not available.");
    const snapshot = publication.finalSnapshot;
    if (!isPublicRankingSnapshot(snapshot)) throw notFound("Public rankings are not available.");
    const history = publicHistoryFromSnapshot(snapshot, playerKey);
    if (!history) throw notFound("Public rankings are not available.");
    responseData(response, history);
    return;
  }
  const workspace = await db.queueWorkspace.findUnique({ where: { queueMasterId: publication.queueMasterId } });
  if (!workspace || workspace.startedAt.getTime() !== publication.sessionStartedAt.getTime()) throw notFound("Public rankings are not available.");
  const rows = await rankingRows(publication.queueMasterId);
  const player = rows.find((row: any) => publicPlayerKey(publication.id, row.id) === playerKey);
  if (!player) throw notFound("Public rankings are not available.");
  const matches = await db.match.findMany({ where: { queueMasterId: publication.queueMasterId, status: MatchStatus.COMPLETED, participants: { some: { queuePlayerId: player.id } } }, include: { participants: { include: { queuePlayer: true } }, scoreRevisions: { include: { games: true } } }, orderBy: { completedAt: "desc" }, take: PUBLIC_RANKING_MATCH_LIMIT });
  const history = { player: { playerKey, player: player.displayNameSnapshot }, matches: matches.map((match: any) => publicMatchFromRecord(match, publication.id)).filter(Boolean).map((match: any) => ({ matchKey: match.matchKey, completedAt: match.completedAt, winnerTeam: match.winnerTeam, result: match.winnerTeam && match.participants.some((participant: any) => participant.playerKey === playerKey && participant.team === match.winnerTeam) ? "WIN" : "LOSS", teamA: match.participants.filter((participant: any) => participant.team === "A").sort((left: any, right: any) => left.teamSlot - right.teamSlot).map((participant: any) => participant.player), teamB: match.participants.filter((participant: any) => participant.team === "B").sort((left: any, right: any) => left.teamSlot - right.teamSlot).map((participant: any) => participant.player), games: match.games })) };
  responseData(response, history);
}));
api.get("/queue/players/:id/history", requireAuth, route(async (request, response) => { const player = await ownedQueuePlayer(request, request.params.id); const query = parse(historyQuerySchema, request.query); const matches = (await matchHistoryFor(authUser(request).id)).filter((match: any) => match.participants.some((p: any) => p.queuePlayerId === player.id)); const rows = matches.map((match: any) => historyMatchView(match)); let wins = 0; let pointsFor = 0; let pointsAgainst = 0; for (const match of matches) { const participant = match.participants.find((p: any) => p.queuePlayerId === player.id); const revision = match.scoreRevisions.find((r: any) => r.id === match.currentRevisionId); if (!participant || !revision) continue; const a = revision.games.reduce((sum: number, game: any) => sum + game.teamAScore, 0); const b = revision.games.reduce((sum: number, game: any) => sum + game.teamBScore, 0); pointsFor += participant.team === TeamSide.A ? a : b; pointsAgainst += participant.team === TeamSide.A ? b : a; if (participant.team === revision.winnerTeam) wins += 1; } responseData(response, { player: { queuePlayerId: player.id, playerId: player.playerId, displayName: player.displayNameSnapshot, gender: player.genderSnapshot, skillLevel: player.skillLevelSnapshot }, stats: { matchesPlayed: matches.length, wins, losses: matches.length - wins, winRateBasisPoints: matches.length ? Math.floor((wins * 10000) / matches.length) : 0, pointsFor, pointsAgainst, pointDifferential: pointsFor - pointsAgainst, averageDurationSeconds: matches.length ? Math.round(matches.map((m: any) => historyDurationSeconds(m)).filter((v: number | null): v is number => v !== null).reduce((a: number, b: number) => a + b, 0) / Math.max(1, matches.filter((m: any) => m.startedAt && m.completedAt).length)) : null, mostPlayedPartner: null, mostPlayedOpponent: null }, ...pageResult(rows, query.page, query.pageSize) }); }));

api.get("/fees", requireAuth, route(async (request, response) => { responseData(response, await feeSummary(authUser(request).id)); }));
api.put("/fees/config", requireAuth, requireMutationOrigin, route(async (request, response) => { const body = parse(z.object({ mode: z.enum([FeeMode.FIXED_PER_PLAYER, FeeMode.EQUAL_SPLIT]), fixedAmountPerPlayerMinor: z.number().int().min(0).nullable().optional(), expectedQueueCostMinor: z.number().int().min(0).nullable().optional() }), request.body); const settings = (await ensureWorkspace(authUser(request).id)).settings; const expected = body.expectedQueueCostMinor ?? 0; const players = await db.queuePlayer.findMany({ where: { queueMasterId: authUser(request).id, checkedInAt: { not: null } } }); const allocations = body.mode === FeeMode.FIXED_PER_PLAYER ? new Map(players.map((p: any) => [p.id, body.fixedAmountPerPlayerMinor ?? 0])) : allocateEqualSplit(expected, players.map((p: any) => p.id)); const configRecord = await db.$transaction(async (tx: any) => { const next = await tx.queueFeeConfig.upsert({ where: { queueMasterId: authUser(request).id }, create: { queueMasterId: authUser(request).id, mode: body.mode, currencyCode: settings.currencyCode, fixedAmountPerPlayerMinor: body.fixedAmountPerPlayerMinor ?? null, expectedQueueCostMinor: expected }, update: { mode: body.mode, fixedAmountPerPlayerMinor: body.fixedAmountPerPlayerMinor ?? null, expectedQueueCostMinor: expected, version: { increment: 1 } } }); await Promise.all(players.map((p: any) => tx.queuePlayer.update({ where: { id: p.id }, data: { amountDueMinor: allocations.get(p.id) ?? 0, version: { increment: 1 } } }))); return next; }); responseData(response, { config: configRecord, summary: await feeSummary(authUser(request).id) }); }));
api.get("/payments", requireAuth, route(async (request, response) => { responseData(response, await db.payment.findMany({ where: { queueMasterId: authUser(request).id }, orderBy: { occurredAt: "desc" }, take: 200 })); }));
api.post("/payments", requireAuth, requireMutationOrigin, route(async (request, response) => { const key = request.get("idempotency-key"); if (!key) throw badRequest("Idempotency-Key is required."); const body = parse(z.object({ queuePlayerId: idSchema, kind: z.enum([PaymentKind.COLLECTION, PaymentKind.WAIVER]), amountMinor: z.number().int().positive().max(2_000_000_000), method: z.enum([PaymentMethod.CASH, PaymentMethod.EWALLET, PaymentMethod.OTHER]).optional(), reference: z.string().max(120).optional(), note: z.string().max(500).optional() }), request.body); const queuePlayerId = body.queuePlayerId; const existing = await db.idempotencyRecord.findFirst({ where: { queueMasterId: authUser(request).id, operation: "PAYMENT_CREATE", key } }); if (existing) { const payment = await db.payment.findUnique({ where: { id: existing.resultId } }); responseData(response, { payment, summary: await feeSummary(authUser(request).id), replayed: true }); return; } const player = await db.queuePlayer.findFirst({ where: { id: queuePlayerId, queueMasterId: authUser(request).id } }); if (!player) throw notFound("Queue player not found."); const result = await db.$transaction(async (tx: any) => { const payment = await tx.payment.create({ data: { queueMasterId: authUser(request).id, queuePlayerId, kind: body.kind, amountMinor: body.amountMinor, method: body.method, reference: body.reference, note: body.note, recordedById: authUser(request).id } }); await tx.idempotencyRecord.create({ data: { queueMasterId: authUser(request).id, operation: "PAYMENT_CREATE", key, requestHash: createHash("sha256").update(JSON.stringify(body)).digest("hex"), resultType: "PAYMENT", resultId: payment.id, responseStatus: 201, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } }); return payment; }); responseData(response, { payment: result, summary: await feeSummary(authUser(request).id), replayed: false }, 201); }));

async function buildSnapshot(queueMasterId: string): Promise<CloudSnapshotV2> { const settings = await db.queueMasterSettings.findUnique({ where: { queueMasterId } }); const workspace = await db.queueWorkspace.findUnique({ where: { queueMasterId } }); const players = await db.player.findMany({ where: { queueMasterId } }); const queuePlayers = await db.queuePlayer.findMany({ where: { queueMasterId } }); const courts = await db.court.findMany({ where: { queueMasterId } }); const matches = await db.match.findMany({ where: { queueMasterId }, include: { participants: true, scoreRevisions: { include: { games: true } } } }); const feeConfig = await db.queueFeeConfig.findUnique({ where: { queueMasterId } }); const payments = await db.payment.findMany({ where: { queueMasterId } }); const audits = await db.auditLog.findMany({ where: { queueMasterId } }); return { schemaVersion: 2, queueMasterId, settings: settings ? settingsView(settings) : null, workspace: { startedAt: workspace.startedAt.toISOString(), endedAt: workspace.endedAt?.toISOString() ?? null, lateArrivalCutoffAt: workspace.lateArrivalCutoffAt?.toISOString() ?? null, matchmakingAlgorithm: workspace.matchmakingAlgorithm, matchmakingRevision: workspace.matchmakingRevision, version: workspace.version }, players: players.map((p: any) => ({ id: p.id, displayName: p.displayName, gender: p.gender, skillLevel: p.skillLevel, skillWeight: p.skillWeight, status: p.status })), queuePlayers: queuePlayers.map((p: any) => ({ id: p.id, playerId: p.playerId, displayName: p.displayNameSnapshot, gender: p.genderSnapshot, skillLevel: p.skillLevelSnapshot, skillWeight: p.skillWeightSnapshot, status: p.status, queueEnteredAt: p.queueEnteredAt?.toISOString() ?? null, lastMatchEndedAt: p.lastMatchEndedAt?.toISOString() ?? null, matchesPlayed: p.matchesPlayed, wins: p.wins, losses: p.losses, pointsFor: p.pointsFor, pointsAgainst: p.pointsAgainst, amountDueMinor: p.amountDueMinor, manualPriority: p.manualPriority, priorityReason: p.priorityReason, latePenaltyState: p.latePenaltyState, latePenaltyAppliedAt: p.latePenaltyAppliedAt?.toISOString() ?? null, currentMatchId: p.currentMatchId, checkedInAt: p.checkedInAt?.toISOString() ?? null, checkedOutAt: p.checkedOutAt?.toISOString() ?? null, restStartedAt: p.restStartedAt?.toISOString() ?? null, version: p.version })), courts: courts.map((c: any) => ({ id: c.id, name: c.name, normalizedName: c.normalizedName, displayOrder: c.displayOrder, status: c.status, currentMatchId: c.currentMatchId, closedAt: c.closedAt?.toISOString() ?? null, version: c.version })), matches: matches.map((m: any) => ({ id: m.id, courtId: m.courtId, status: m.status, source: m.source, matchmakingMode: m.matchmakingMode, algorithmVersion: m.algorithmVersion, suggestionKey: m.suggestionKey, suggestionExplanation: m.suggestionExplanation, pointsToWin: m.pointsToWin, winBy: m.winBy, scoreCap: m.scoreCap, bestOf: m.bestOf as 1 | 3, queuedAt: m.queuedAt.toISOString(), startedAt: m.startedAt?.toISOString() ?? null, completedAt: m.completedAt?.toISOString() ?? null, cancelledAt: m.cancelledAt?.toISOString() ?? null, cancellationReason: m.cancellationReason, winnerTeam: m.winnerTeam, currentRevisionId: m.currentRevisionId, version: m.version, participants: m.participants.map((p: any) => ({ id: p.id, matchId: p.matchId, queuePlayerId: p.queuePlayerId, team: p.team, teamSlot: p.teamSlot, priorQueueEnteredAt: p.priorQueueEnteredAt?.toISOString() ?? null })), scoreRevisions: m.scoreRevisions.map((r: any) => ({ id: r.id, matchId: r.matchId, revisionNumber: r.revisionNumber, winnerTeam: r.winnerTeam, reason: r.reason, supersedesRevisionId: r.supersedesRevisionId, createdAt: r.createdAt.toISOString(), games: r.games.map((g: any) => ({ id: g.id, scoreRevisionId: g.scoreRevisionId, gameNumber: g.gameNumber, teamAScore: g.teamAScore, teamBScore: g.teamBScore, winnerTeam: g.winnerTeam })) })) })), feeConfig: feeConfig ? { id: feeConfig.id, mode: feeConfig.mode, currencyCode: feeConfig.currencyCode, fixedAmountPerPlayerMinor: feeConfig.fixedAmountPerPlayerMinor, expectedQueueCostMinor: feeConfig.expectedQueueCostMinor, participationRule: feeConfig.participationRule, frozenAt: feeConfig.frozenAt?.toISOString() ?? null, version: feeConfig.version } : null, payments: payments.map((p: any) => ({ id: p.id, queuePlayerId: p.queuePlayerId, kind: p.kind, method: p.method, amountMinor: p.amountMinor, reference: p.reference, note: p.note, reversalOfPaymentId: p.reversalOfPaymentId, recordedById: p.recordedById, occurredAt: p.occurredAt.toISOString(), createdAt: p.createdAt.toISOString() })), audits: audits.map((a: any) => ({ id: a.id, action: a.action, entityType: a.entityType, entityId: a.entityId, reason: a.reason, beforeJson: a.beforeJson, afterJson: a.afterJson, requestId: a.requestId, createdAt: a.createdAt.toISOString() })) }; }
const snapshotChecksum = (snapshot: CloudSnapshotV2) => createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
api.put("/sync/snapshot", requireAuth, requireMutationOrigin, route(async (request, response) => {
  const body = parse(z.object({ schemaVersion: z.literal(2), deviceId: z.string().min(1).max(200), operationId: z.string().min(1).max(200), baseCloudRevision: z.number().int().min(0), force: z.boolean().default(false), snapshot: z.record(z.string(), z.unknown()), auditEvents: z.array(z.record(z.string(), z.unknown())).max(2000).default([]) }), request.body);
  const snapshot = body.snapshot as unknown as CloudSnapshotV2;
  if (snapshot.queueMasterId !== authUser(request).id || snapshot.schemaVersion !== 2) throw badRequest("The snapshot is not valid for this account.");
  try {
    const result = await withTransactionRetry((tx) => persistSyncSnapshot(tx, { ...body, snapshot } as SyncUpload, authUser(request).id), { maxWait: 10_000, timeout: 30_000 });
    responseData(response, { cloudRevision: result.state.cloudRevision, lastSyncedAt: result.state.lastSyncedAt, schemaVersion: 2, alreadyApplied: result.alreadyApplied });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const target = error instanceof Prisma.PrismaClientKnownRequestError ? error.meta?.target : undefined;
      const fields = Array.isArray(target) ? target.filter((value): value is string => typeof value === "string") : typeof target === "string" ? [target] : undefined;
      const entity = error instanceof Prisma.PrismaClientKnownRequestError && typeof error.meta?.modelName === "string" ? error.meta.modelName : undefined;
      logger.warn({ requestId: response.locals.requestId, operationId: body.operationId, deviceId: body.deviceId, entity, fields }, "offline sync unique constraint");
      throw conflict("SYNC_UNIQUE_CONFLICT", "The offline snapshot conflicts with an existing record.", entity || fields?.length ? { ...(entity ? { entity } : {}), ...(fields?.length ? { fields } : {}) } : undefined);
    }
    throw error;
  }
}));
async function snapshotWithMatchSnapshots(snapshot: CloudSnapshotV2): Promise<CloudSnapshotV2> { const normalized = normalizeQueuePlayerSnapshotFields(snapshot) as CloudSnapshotV2; const rows = await db.match.findMany({ where: { queueMasterId: normalized.queueMasterId }, select: { id: true, courtIdSnapshot: true, courtNameSnapshot: true } }); const byId = new Map<string, any>(rows.map((row: any) => [row.id, row] as [string, any])); return { ...normalized, matches: normalized.matches.map((match) => { const stored = match.suggestionExplanation && typeof match.suggestionExplanation === "object" ? (match.suggestionExplanation as Record<string, unknown>).__courtSnapshot : null; const record = stored && typeof stored === "object" ? stored as { id?: unknown; name?: unknown } : null; return { ...match, courtIdSnapshot: match.courtIdSnapshot ?? byId.get(match.id)?.courtIdSnapshot ?? (record?.id ? String(record.id) : null), courtNameSnapshot: match.courtNameSnapshot ?? byId.get(match.id)?.courtNameSnapshot ?? (record?.name ? String(record.name) : null) }; }) }; }
api.get("/sync/status", requireAuth, route(async (request, response) => { const state = await db.accountSyncState.upsert({ where: { queueMasterId: authUser(request).id }, create: { queueMasterId: authUser(request).id, schemaVersion: 2 }, update: { schemaVersion: 2 } }); responseData(response, { cloudRevision: state.cloudRevision, lastSyncedAt: state.lastSyncedAt, lastDeviceId: state.lastDeviceId, schemaVersion: 2 }); }));
api.get("/sync/snapshot", requireAuth, route(async (request, response) => { const snapshot = await snapshotWithMatchSnapshots(await buildSnapshot(authUser(request).id)); const state = await db.accountSyncState.upsert({ where: { queueMasterId: authUser(request).id }, create: { queueMasterId: authUser(request).id, schemaVersion: 2 }, update: { schemaVersion: 2 } }); responseData(response, { snapshot, checksum: snapshotChecksum(snapshot), cloudRevision: state.cloudRevision, schemaVersion: 2 }); }));

api.get("/admin/accounts", requireAuth, requireSuperAdmin, route(async (_request, response) => { const accounts = await db.queueMaster.findMany({ orderBy: { normalizedUsername: "asc" }, include: { _count: { select: { players: true, queuePlayers: true, courts: true, matches: true } } } }); responseData(response, accounts.map(accountView)); }));
api.post("/admin/accounts", requireAuth, requireSuperAdmin, requireMutationOrigin, route(async (request, response) => { const body = parse(z.object({ username: z.string().min(1).max(80), password: accountPasswordSchema, role: z.nativeEnum(AccountRole) }), request.body); const username = normalizeText(body.username); const account = await db.queueMaster.create({ data: { username, normalizedUsername: normalizeUsername(username), passwordHash: await passwordHash(body.password), role: body.role, settings: { create: {} }, workspace: { create: {} } }, include: { _count: { select: { players: true, queuePlayers: true, courts: true, matches: true } } } }); await ensureWorkspace(account.id); responseData(response, accountView(account), 201); }));
api.patch("/admin/accounts/:id", requireAuth, requireSuperAdmin, requireMutationOrigin, route(async (request, response) => { const current = await db.queueMaster.findUnique({ where: { id: request.params.id } }); if (!current) throw notFound("Account not found."); assertVersion(current.version, versionFrom(request)); const body = parse(z.object({ role: z.nativeEnum(AccountRole).optional(), status: z.nativeEnum(QueueMasterStatus).optional() }), request.body); const updated = await db.queueMaster.update({ where: { id: current.id }, data: { role: body.role, status: body.status, version: { increment: 1 } }, include: { _count: { select: { players: true, queuePlayers: true, courts: true, matches: true } } } }); responseData(response, accountView(updated)); }));
api.post("/admin/accounts/:id/reset-password", requireAuth, requireSuperAdmin, requireMutationOrigin, route(async (request, response) => { const current = await db.queueMaster.findUnique({ where: { id: request.params.id } }); if (!current) throw notFound("Account not found."); assertVersion(current.version, versionFrom(request)); const body = parse(z.object({ password: accountPasswordSchema }), request.body); await db.queueMaster.update({ where: { id: current.id }, data: { passwordHash: await passwordHash(body.password), passwordChangedAt: new Date(), version: { increment: 1 } } }); noContent(response); }));
api.get("/admin/accounts/:id/deletion-preview", requireAuth, requireSuperAdmin, route(async (request, response) => { const account = await db.queueMaster.findUnique({ where: { id: request.params.id }, include: { _count: { select: { players: true, queuePlayers: true, courts: true, matches: true, payments: true, auditLogs: true, authSessions: true, idempotencyRecords: true } } } }); if (!account) throw notFound("Account not found."); const [participants, revisions, games, feeConfig] = await Promise.all([db.matchParticipant.count({ where: { match: { queueMasterId: account.id } } }), db.matchScoreRevision.count({ where: { match: { queueMasterId: account.id } } }), db.matchGame.count({ where: { scoreRevision: { match: { queueMasterId: account.id } } } }), db.queueFeeConfig.count({ where: { queueMasterId: account.id } })]); responseData(response, { account: accountView(account), deletion: { accountId: account.id, playerCount: account._count.players, queuePlayerCount: account._count.queuePlayers, courtCount: account._count.courts, matchCount: account._count.matches, participantCount: participants, scoreRevisionCount: revisions, gameCount: games, paymentCount: account._count.payments, feeConfigCount: feeConfig, auditCount: account._count.auditLogs, authSessionCount: account._count.authSessions, idempotencyRecordCount: account._count.idempotencyRecords } }); }));
api.delete("/admin/accounts/:id", requireAuth, requireSuperAdmin, requireMutationOrigin, route(async (request, response) => { const current = await db.queueMaster.findUnique({ where: { id: request.params.id } }); if (!current) throw notFound("Account not found."); assertVersion(current.version, versionFrom(request)); const body = parse(z.object({ confirmationUsername: z.string(), currentPassword: z.string() }), request.body); if (body.confirmationUsername !== current.username || !(await verifyPassword(authUser(request).passwordHash, body.currentPassword).catch(() => false))) throw forbidden("The confirmation details are invalid."); await withTransactionRetry(async (tx) => { await tx.matchGame.deleteMany({ where: { scoreRevision: { match: { queueMasterId: current.id } } } }); await tx.matchScoreRevision.deleteMany({ where: { match: { queueMasterId: current.id } } }); await tx.matchParticipant.deleteMany({ where: { match: { queueMasterId: current.id } } }); await tx.match.deleteMany({ where: { queueMasterId: current.id } }); await tx.payment.deleteMany({ where: { queueMasterId: current.id } }); await tx.queuePlayer.deleteMany({ where: { queueMasterId: current.id } }); await tx.court.deleteMany({ where: { queueMasterId: current.id } }); await tx.queueFeeConfig.deleteMany({ where: { queueMasterId: current.id } }); await tx.publicRankingPublication.deleteMany({ where: { queueMasterId: current.id } }); await tx.queueWorkspace.deleteMany({ where: { queueMasterId: current.id } }); await tx.queueMasterSettings.deleteMany({ where: { queueMasterId: current.id } }); await tx.auditLog.deleteMany({ where: { queueMasterId: current.id } }); await tx.idempotencyRecord.deleteMany({ where: { queueMasterId: current.id } }); await tx.authSession.deleteMany({ where: { queueMasterId: current.id } }); await tx.player.deleteMany({ where: { queueMasterId: current.id } }); await tx.accountSyncState.deleteMany({ where: { queueMasterId: current.id } }); await tx.queueMaster.delete({ where: { id: current.id } }); }); noContent(response); }));

export function createApp() { const app = express(); app.set("trust proxy", config.trustProxyHops); app.use(helmet()); app.use(cors({ credentials: true, origin: (origin, callback) => { if (!origin || config.frontendOrigins.includes(origin)) callback(null, true); else callback(null, false); } })); app.use(express.json({ limit: "25mb" })); app.use(cookieParser()); app.use((pinoHttp as unknown as (options: unknown) => RequestHandler)({ logger, genReqId: () => randomUUID() })); app.use((request, response, next) => { response.locals.requestId = request.id; next(); }); app.get("/health", (_request, response) => response.json({ ok: true })); app.use("/api/v1", (_request, response) => response.status(426).json({ error: { code: "UPGRADE_REQUIRED", message: "This client must be upgraded to the current queue API." } })); app.use("/api/v2", rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false }), api); app.use((_request, _response, next) => next(notFound("Route not found."))); app.use(errorHandler); return app; }
api.post("/matches/:id/correct", requireAuth, requireMutationOrigin, route(async (request, response) => { const body = parse(z.object({ games: z.array(z.object({ teamAScore: z.number().int(), teamBScore: z.number().int() })).min(1).max(3), reason: z.string().min(1).max(500).optional() }), request.body); const match = await ownedMatch(request, request.params.id, true); if (match.status !== MatchStatus.COMPLETED) throw conflict("MATCH_NOT_COMPLETED", "Only completed matches can be corrected."); const validated = validateScores(body.games as ScoreInput[], scoreSettings(match)); const winnerTeam = validated.filter((game) => game.winnerTeam === TeamSide.A).length > validated.length / 2 ? TeamSide.A : TeamSide.B; const result = await withTransactionRetry(async (tx: any) => { const revision = await tx.matchScoreRevision.create({ data: { matchId: match.id, revisionNumber: (match.scoreRevisions?.[0]?.revisionNumber ?? 0) + 1, winnerTeam, reason: body.reason ?? "Score correction", createdByQueueMasterId: authUser(request).id, supersedesRevisionId: match.currentRevisionId, games: { create: validated.map((game, index) => ({ gameNumber: index + 1, teamAScore: game.teamAScore, teamBScore: game.teamBScore, winnerTeam: game.winnerTeam })) } }, include: { games: true } }); await tx.match.update({ where: { id: match.id }, data: { winnerTeam, currentRevisionId: revision.id, version: { increment: 1 } } }); const completed = await tx.match.findMany({ where: { queueMasterId: authUser(request).id, status: MatchStatus.COMPLETED }, include: { participants: true, scoreRevisions: { include: { games: true } } } }); await tx.queuePlayer.updateMany({ where: { queueMasterId: authUser(request).id }, data: { matchesPlayed: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 } }); for (const item of completed) { const current = item.scoreRevisions.find((revision: any) => revision.id === item.currentRevisionId); if (!current) continue; const points = current.games.reduce((sum: any, game: any) => ({ a: sum.a + game.teamAScore, b: sum.b + game.teamBScore }), { a: 0, b: 0 }); for (const participant of item.participants) { const won = participant.team === current.winnerTeam; await tx.queuePlayer.update({ where: { id: participant.queuePlayerId }, data: { matchesPlayed: { increment: 1 }, wins: { increment: won ? 1 : 0 }, losses: { increment: won ? 0 : 1 }, pointsFor: { increment: participant.team === TeamSide.A ? points.a : points.b }, pointsAgainst: { increment: participant.team === TeamSide.A ? points.b : points.a } } }); } } await audit(tx, request, { action: "MATCH_SCORE_CORRECTED", entityType: "MATCH", entityId: match.id, reason: body.reason ?? "Score correction" }); return tx.match.findUnique({ where: { id: match.id }, include: { participants: { include: { queuePlayer: true } }, court: true, scoreRevisions: { include: { games: true }, orderBy: { revisionNumber: "desc" } } } }); }); responseData(response, matchView(result)); }));
api.get("/history", requireAuth, route(async (request, response) => { const query = parse(historyQuerySchema, request.query); const matches = await matchHistoryFor(authUser(request).id); const search = query.search.toLowerCase(); const rows = matches.map((match: any) => historyMatchView(match)).filter((match: any) => !search || match.participants.some((p: any) => String(p.displayName).toLowerCase().includes(search))); responseData(response, pageResult(rows, query.page, query.pageSize)); }));
api.post("/workspace/end", requireAuth, requireMutationOrigin, route(async (request, response) => {
  const queueMasterId = authUser(request).id;
  const expected = versionFrom(request);
  const settings = await db.queueMasterSettings.findUnique({ where: { queueMasterId } });
  const result = await withTransactionRetry(async (tx) => {
    const workspace = await tx.queueWorkspace.findUnique({ where: { queueMasterId } });
    if (!workspace) throw notFound("Queue workspace not found.");
    assertVersion(workspace.version, expected);
    const active = await tx.match.count({ where: { queueMasterId, status: MatchStatus.IN_PROGRESS } });
    if (active) throw conflict("MATCHES_IN_PROGRESS", "Finish or discard every playing match before ending the session.");
    const endedAt = new Date();
    await finalizePublicRankingPublication(tx, queueMasterId, workspace, endedAt);
    const queued = await tx.match.findMany({ where: { queueMasterId, status: MatchStatus.QUEUED }, select: { id: true, participants: { select: { queuePlayerId: true } } } });
    if (queued.length) {
      await tx.match.updateMany({ where: { queueMasterId, status: MatchStatus.QUEUED }, data: { status: MatchStatus.CANCELLED, cancelledAt: endedAt, cancellationReason: "Session ended", version: { increment: 1 } } });
      const affected = [...new Set(queued.flatMap((match: any) => match.participants.map((participant: any) => participant.queuePlayerId)))];
      await reconcileQueuePlayers(tx, queueMasterId, affected, endedAt);
    }
    await tx.queuePlayer.updateMany({ where: { queueMasterId, checkedInAt: { not: null }, status: { not: QueuePlayerStatus.CHECKED_OUT } }, data: { status: QueuePlayerStatus.CHECKED_OUT, checkedOutAt: endedAt, queueEnteredAt: null, currentMatchId: null, version: { increment: 1 } } });
    const checkedIn = await tx.queuePlayer.findMany({ where: { queueMasterId, checkedInAt: { not: null } }, select: { id: true } });
    const currentConfig = await tx.queueFeeConfig.findUnique({ where: { queueMasterId } });
    const mode = currentConfig?.mode ?? settings?.defaultFeeMode ?? FeeMode.FIXED_PER_PLAYER;
    const expectedCost = currentConfig?.expectedQueueCostMinor ?? 0;
    const allocations = mode === FeeMode.FIXED_PER_PLAYER ? new Map(checkedIn.map((player: any) => [player.id, currentConfig?.fixedAmountPerPlayerMinor ?? settings?.defaultFixedFeeMinor ?? 0])) : allocateEqualSplit(expectedCost, checkedIn.map((player: any) => player.id));
    await Promise.all(checkedIn.map((player: any) => tx.queuePlayer.update({ where: { id: player.id }, data: { amountDueMinor: allocations.get(player.id) ?? 0, version: { increment: 1 } } })));
    await tx.queueFeeConfig.upsert({ where: { queueMasterId }, create: { queueMasterId, mode, currencyCode: settings?.currencyCode ?? "PHP", fixedAmountPerPlayerMinor: mode === FeeMode.FIXED_PER_PLAYER ? currentConfig?.fixedAmountPerPlayerMinor ?? settings?.defaultFixedFeeMinor ?? 0 : null, expectedQueueCostMinor: expectedCost, frozenAt: endedAt }, update: { frozenAt: endedAt, version: { increment: 1 } } });
    const updated = await tx.queueWorkspace.update({ where: { queueMasterId, version: expected }, data: { endedAt, matchmakingRevision: { increment: 1 }, version: { increment: 1 } } });
    await audit(tx, request, { action: "SESSION_ENDED", entityType: "WORKSPACE", entityId: queueMasterId, reason: "Queue Master ended the session", after: { endedAt, cancelledQueuedMatches: queued.length, checkedInPlayers: checkedIn.length } });
    return updated;
  });
  const account = await db.queueMaster.findUnique({ where: { id: queueMasterId }, select: { _count: { select: { queuePlayers: true, courts: true } } } });
  responseData(response, workspaceView(result, settings, account?._count, await db.queueFeeConfig.findUnique({ where: { queueMasterId } })));
}));
api.patch("/matches/:id", requireAuth, requireMutationOrigin, route(async (request, response) => {
  const queueMasterId = authUser(request).id;
  await activeWorkspaceFor(request);
  const body = parse(z.object({ teamA: z.array(idSchema).min(1).max(2), teamB: z.array(idSchema).min(1).max(2) }), request.body);
  if (body.teamA.length !== body.teamB.length || new Set([...body.teamA, ...body.teamB]).size !== body.teamA.length + body.teamB.length) throw badRequest("Choose unique players with equal team sizes for singles or doubles.");
  const expected = versionFrom(request);
  const updatedId = await withTransactionRetry(async (tx) => {
    const match = await tx.match.findFirst({ where: { id: String(request.params.id), queueMasterId }, include: { participants: true } });
    if (!match) throw notFound("Match not found.");
    if (match.status !== MatchStatus.QUEUED) throw conflict("MATCH_NOT_QUEUED", "Only queued matches can be edited.");
    assertVersion(match.version, expected);
    const ids = [...body.teamA, ...body.teamB];
    const players = await tx.queuePlayer.findMany({ where: { id: { in: ids }, queueMasterId } });
    if (players.length !== ids.length || players.some((player: any) => ![QueuePlayerStatus.WAITING, QueuePlayerStatus.QUEUED, QueuePlayerStatus.PLAYING].includes(player.status))) throw conflict("PLAYER_BUSY", "Every selected player must be waiting, queued, or playing.");
    const priorById = new Map(match.participants.map((participant: any) => [participant.queuePlayerId, participant.priorQueueEnteredAt]));
    await tx.matchParticipant.deleteMany({ where: { matchId: match.id } });
    await tx.matchParticipant.createMany({ data: ids.map((queuePlayerId) => ({ matchId: match.id, queuePlayerId, team: body.teamA.includes(queuePlayerId) ? TeamSide.A : TeamSide.B, teamSlot: body.teamA.includes(queuePlayerId) ? body.teamA.indexOf(queuePlayerId) + 1 : body.teamB.indexOf(queuePlayerId) + 1, priorQueueEnteredAt: priorById.get(queuePlayerId) ?? players.find((player: any) => player.id === queuePlayerId)?.queueEnteredAt ?? null })) });
    const affected = [...new Set([...match.participants.map((participant: any) => participant.queuePlayerId), ...ids])];
    await reconcileQueuePlayers(tx, queueMasterId, affected);
    await tx.match.update({ where: { id: match.id, version: expected }, data: { source: MatchSource.MANUAL_ADJUSTED, matchmakingMode: null, algorithmVersion: null, suggestionKey: null, suggestionExplanation: null, version: { increment: 1 } } });
    await tx.queueWorkspace.update({ where: { queueMasterId }, data: { matchmakingRevision: { increment: 1 }, version: { increment: 1 } } });
    await audit(tx, request, { action: "MATCH_UPDATED", entityType: "MATCH", entityId: match.id, reason: "Queued lineup edited by Queue Master", before: match.participants, after: { teamA: body.teamA, teamB: body.teamB } });
    return match.id;
  });
  responseData(response, matchView(await db.match.findUnique({ where: { id: updatedId }, include: { participants: { include: { queuePlayer: true } }, court: true } })));
}));
