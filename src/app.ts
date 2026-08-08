import { createHash, createHmac, randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pino from "pino";
import pinoHttpModule from "pino-http";
import { Prisma, Gender, MatchStatus, MatchSource, MatchmakingMode, PaymentKind, PaymentMethod, PlayerStatus, QueueMasterStatus, SessionPlayerStatus, SessionStatus, TeamSide, CourtStatus, FeeMode, SkillLevel } from "@prisma/client";
import { z } from "zod";
import { prisma, withTransactionRetry } from "./lib/db.js";
import { chooseFrequentParticipant, historyDurationSeconds, historyMatchView } from "./lib/history.js";
import { config } from "./lib/config.js";
import { AppError, badRequest, conflict, notFound, unauthorized } from "./lib/errors.js";
import { normalizeName, normalizeText, normalizeUsername } from "./lib/normalize.js";
import { skillWeight } from "./lib/skills.js";
import { allocateEqualSplit } from "./lib/fees.js";
import { suggestMatch, type MatchHistory, type MatchPlayer } from "./lib/matchmaking.js";
import { validateScores, type ScoreInput } from "./lib/score.js";
import { clearLoginFailures, clearSessionCookie, currentCsrfToken, issueSession, recordLoginFailure, requireAuth, requireMutationOrigin, rotateSession, throttleLogin, verifyPassword, type AuthenticatedRequest } from "./lib/auth.js";
import type { CloudSnapshotV1 } from "@shuttle-queue/domain";

const logger = pino({ level: config.logLevel, redact: ["req.headers.cookie", "req.headers.authorization", "password", "passwordHash"] });
const pinoHttp = pinoHttpModule as unknown as (options: unknown) => RequestHandler;
const MATCHMAKING_ALGORITHM = "v2-rotation";
const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  const err = error instanceof AppError
    ? error
    : error instanceof z.ZodError
      ? new AppError(422, "VALIDATION_ERROR", "The request is invalid.", error.flatten())
      : error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
        ? new AppError(409, "CONFLICT", "The requested value is already in use.")
        : error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034"
          ? new AppError(409, "CONCURRENCY_CONFLICT", "The data changed concurrently. Retry the request.")
        : error;
  const status = err instanceof AppError ? err.status : 500;
  if (status >= 500) logger.error({ err: error, requestId: response.locals.requestId }, "request failed");
  response.status(status).json({ error: { code: err instanceof AppError ? err.code : "INTERNAL_ERROR", message: status >= 500 ? "An unexpected server error occurred." : err.message, ...(err instanceof AppError && err.details !== undefined ? { details: err.details } : {}) }, requestId: response.locals.requestId });
};
type RouteRequest = Request<Record<string, string>>;
type Handler = (request: RouteRequest, response: Response) => Promise<void>;
const route = (handler: Handler): RequestHandler => (request, response, next) => { Promise.resolve(handler(request as RouteRequest, response)).catch(next); };
const api = express.Router();

// Legacy REST mutations remain supported by the web client and other callers. Keep the
// account revision moving for those writes so offline devices can detect cloud changes.
api.use((request, response, next) => {
  response.once("finish", () => {
    const auth = (request as AuthenticatedRequest).auth;
    if (request.method !== "GET" && request.method !== "HEAD" && response.statusCode < 400 && auth && !request.path.startsWith("/sync/")) {
      void prisma.accountSyncState.upsert({ where: { queueMasterId: auth.queueMaster.id }, create: { queueMasterId: auth.queueMaster.id, cloudRevision: 2, lastSyncedAt: new Date() }, update: { cloudRevision: { increment: 1 }, lastSyncedAt: new Date() } }).catch(() => undefined);
    }
  });
  next();
});

const syncRecordId = (value: unknown) => typeof value === "string" && idSchema.safeParse(value).success;
const snapshotChecksum = (snapshot: CloudSnapshotV1) => createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

api.get("/sync/status", requireAuth, route(async (request, response) => {
  const queueMasterId = authUser(request).id;
  const state = await prisma.accountSyncState.upsert({ where: { queueMasterId }, create: { queueMasterId }, update: {} });
  responseData(response, { cloudRevision: state.cloudRevision, lastSyncedAt: state.lastSyncedAt, lastDeviceId: state.lastDeviceId, schemaVersion: state.schemaVersion });
}));

api.get("/sync/snapshot", requireAuth, route(async (request, response) => {
  const queueMasterId = authUser(request).id;
  const snapshot = await buildCloudSnapshot(queueMasterId);
  const state = await prisma.accountSyncState.upsert({ where: { queueMasterId }, create: { queueMasterId }, update: {} });
  responseData(response, { snapshot, checksum: snapshotChecksum(snapshot), cloudRevision: state.cloudRevision, schemaVersion: 1 });
}));

api.put("/sync/snapshot", requireAuth, requireMutationOrigin, route(async (request, response) => {
  const queueMasterId = authUser(request).id;
  const body = parse(z.object({ schemaVersion: z.literal(1), deviceId: z.string().min(1).max(200), operationId: z.string().min(1).max(200), baseCloudRevision: z.number().int().min(0), force: z.boolean().default(false), snapshot: z.record(z.string(), z.unknown()), auditEvents: z.array(z.record(z.string(), z.unknown())).max(2000).default([]) }), request.body);
  const snapshot = validateCloudSnapshot(body.snapshot, queueMasterId);
  const result = await withTransactionRetry(async (tx) => {
    const existingOperation = await tx.idempotencyRecord.findFirst({ where: { queueMasterId, operation: "SYNC_SNAPSHOT", key: body.operationId } });
    if (existingOperation) {
      const current = await tx.accountSyncState.findUnique({ where: { queueMasterId } });
      return { state: current ?? await tx.accountSyncState.create({ data: { queueMasterId } }), alreadyApplied: true };
    }
    const current = await tx.accountSyncState.upsert({ where: { queueMasterId }, create: { queueMasterId }, update: {} });
    if (!body.force && current.cloudRevision !== body.baseCloudRevision) throw conflict("SYNC_CLOUD_CHANGED", "Cloud data changed on another device.", { cloudRevision: current.cloudRevision, lastSyncedAt: current.lastSyncedAt, lastDeviceId: current.lastDeviceId });
    await replaceCloudSnapshot(tx, queueMasterId, snapshot);
    for (const event of body.auditEvents) {
      await tx.auditLog.create({ data: { id: syncRecordId(event.id) ? String(event.id) : randomUUID(), queueMasterId, sessionId: typeof event.sessionId === "string" ? event.sessionId : undefined, action: typeof event.action === "string" ? event.action : "OFFLINE_EVENT", entityType: typeof event.entityType === "string" ? event.entityType : "ACCOUNT", entityId: typeof event.entityId === "string" ? event.entityId : queueMasterId, reason: typeof event.reason === "string" ? event.reason : "Recorded offline", beforeJson: event.beforeJson as Prisma.InputJsonValue | undefined, afterJson: event.afterJson as Prisma.InputJsonValue | undefined, requestId: `offline:${body.operationId}` } });
    }
    await rebuildCareerStats(tx, queueMasterId);
    const state = await tx.accountSyncState.update({ where: { queueMasterId }, data: { cloudRevision: { increment: 1 }, lastDeviceId: body.deviceId, lastOperationId: body.operationId, lastSyncedAt: new Date(), schemaVersion: 1, version: { increment: 1 } } });
    await tx.idempotencyRecord.create({ data: { queueMasterId, operation: "SYNC_SNAPSHOT", key: body.operationId, requestHash: snapshotChecksum(snapshot), resultType: "SYNC", resultId: String(state.cloudRevision), responseStatus: 200, expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30) } });
    return { state, alreadyApplied: false };
  }, { maxWait: 10_000, timeout: 30_000 });
  responseData(response, { cloudRevision: result.state.cloudRevision, lastSyncedAt: result.state.lastSyncedAt, lastDeviceId: result.state.lastDeviceId, schemaVersion: result.state.schemaVersion, alreadyApplied: result.alreadyApplied });
}));

api.post("/sessions/:id/matches/start-suggestion", requireAuth, requireMutationOrigin, route(async (request, response) => {
  const session = await getOwnedSession(request, request.params.id);
  if (session.status !== SessionStatus.ACTIVE) throw conflict("SESSION_NOT_ACTIVE", "Matches require an active session.");
  const body = parse(z.object({ teamA: z.array(idSchema).length(2), teamB: z.array(idSchema).length(2), courtId: idSchema, suggestionToken: z.string().min(20) }), request.body);
  const payload = verifySuggestion(body.suggestionToken);
  const payloadTeamA = Array.isArray(payload.teamA) ? payload.teamA.map(String) : [];
  const payloadTeamB = Array.isArray(payload.teamB) ? payload.teamB.map(String) : [];
  if (payload.sessionId !== session.id || payload.revision !== session.matchmakingRevision || Number(payload.expiresAt) < Date.now() || JSON.stringify(payloadTeamA) !== JSON.stringify(body.teamA) || JSON.stringify(payloadTeamB) !== JSON.stringify(body.teamB)) throw conflict("SUGGESTION_STALE", "Generate a new suggestion.");
  const allIds = [...body.teamA, ...body.teamB];
  const participants = await prisma.sessionPlayer.findMany({ where: { id: { in: allIds }, sessionId: session.id } });
  if (participants.length !== 4 || participants.some((player) => player.status !== SessionPlayerStatus.WAITING || player.currentMatchId)) throw conflict("PLAYER_BUSY", "One or more selected players are no longer waiting.");
  const match = await prisma.$transaction(async (tx) => {
    const court = await tx.sessionCourt.findFirst({ where: { id: body.courtId, sessionId: session.id } });
    if (!court || court.status !== CourtStatus.AVAILABLE || court.currentMatchId) throw conflict("COURT_NOT_AVAILABLE", "The selected court is not available.");
     const created = await tx.match.create({ data: { sessionId: session.id, courtId: court.id, status: MatchStatus.IN_PROGRESS, source: MatchSource.AUTOMATIC, matchmakingMode: payload.mode as MatchmakingMode, algorithmVersion: MATCHMAKING_ALGORITHM, suggestionKey: String(payload.key), suggestionExplanation: payload.explanation as Prisma.InputJsonValue, startedAt: new Date(), participants: { create: allIds.map((id) => ({ sessionPlayerId: id, priorQueueEnteredAt: participants.find((player) => player.id === id)?.queueEnteredAt ?? null, team: body.teamA.includes(id) ? TeamSide.A : TeamSide.B, teamSlot: body.teamA.includes(id) ? body.teamA.indexOf(id) + 1 : body.teamB.indexOf(id) + 1 })) } } });
    const claimedPlayers = await tx.sessionPlayer.updateMany({ where: { id: { in: allIds }, status: SessionPlayerStatus.WAITING, OR: [{ currentMatchId: null }, { currentMatchId: { isSet: false } }] }, data: { status: SessionPlayerStatus.PLAYING, currentMatchId: created.id, manualPriority: 0, priorityReason: null, version: { increment: 1 } } });
    if (claimedPlayers.count !== 4) throw conflict("PLAYER_BUSY", "One or more selected players are no longer waiting.");
    const claimedCourt = await tx.sessionCourt.updateMany({ where: { id: court.id, status: CourtStatus.AVAILABLE, OR: [{ currentMatchId: null }, { currentMatchId: { isSet: false } }] }, data: { status: CourtStatus.OCCUPIED, currentMatchId: created.id, version: { increment: 1 } } });
    if (claimedCourt.count !== 1) throw conflict("COURT_NOT_AVAILABLE", "The selected court is no longer available.");
    await tx.queueSession.update({ where: { id: session.id }, data: { matchmakingRevision: { increment: 1 }, version: { increment: 1 } } });
    return created;
  });
  const detail = await prisma.match.findUnique({ where: { id: match.id }, include: { participants: { include: { sessionPlayer: true } } } });
  responseData(response, matchView(detail), 201);
}));

// Corrections are append-only revisions. The original score remains queryable and the
// player aggregates are adjusted by the delta between the two revisions.
api.post("/matches/:id/corrections", requireAuth, requireMutationOrigin, route(async (request, response) => {
  const body = parse(z.object({ games: z.array(z.object({ teamAScore: z.number().int(), teamBScore: z.number().int() })).min(1).max(3), reason: z.string().min(3).max(300) }), request.body);
  const match = await prisma.match.findFirst({ where: { id: request.params.id, session: { queueMasterId: authUser(request).id } }, include: { participants: true, session: true, scoreRevisions: { include: { games: true }, orderBy: { revisionNumber: "desc" } } } });
  if (!match || match.status !== MatchStatus.COMPLETED) throw conflict("MATCH_NOT_COMPLETED", "Only completed matches can be corrected.");
  const prior = match.scoreRevisions[0]; if (!prior) throw conflict("MATCH_SCORE_MISSING", "The completed match has no score revision.");
  const validated = validateScores(body.games as ScoreInput[], scoreSettings(match.session)); let aWins = 0; let bWins = 0; for (const game of validated) game.winnerTeam === TeamSide.A ? aWins++ : bWins++; const winnerTeam = aWins > bWins ? TeamSide.A : TeamSide.B;
  const oldPoints = prior.games.reduce((sum, game) => ({ a: sum.a + game.teamAScore, b: sum.b + game.teamBScore }), { a: 0, b: 0 }); const newPoints = validated.reduce((sum, game) => ({ a: sum.a + game.teamAScore, b: sum.b + game.teamBScore }), { a: 0, b: 0 });
  const revision = await prisma.$transaction(async (tx) => { const next = await tx.matchScoreRevision.create({ data: { matchId: match.id, revisionNumber: prior.revisionNumber + 1, winnerTeam, reason: body.reason, createdByQueueMasterId: authUser(request).id, supersedesRevisionId: prior.id, games: { create: validated.map((game, index) => ({ gameNumber: index + 1, teamAScore: game.teamAScore, teamBScore: game.teamBScore, winnerTeam: game.winnerTeam })) } } }); await tx.match.update({ where: { id: match.id }, data: { winnerTeam, currentRevisionId: next.id, version: { increment: 1 } } }); for (const participant of match.participants) { const wasWinner = participant.team === prior.winnerTeam; const isWinner = participant.team === winnerTeam; const oldFor = participant.team === TeamSide.A ? oldPoints.a : oldPoints.b; const oldAgainst = participant.team === TeamSide.A ? oldPoints.b : oldPoints.a; const newFor = participant.team === TeamSide.A ? newPoints.a : newPoints.b; const newAgainst = participant.team === TeamSide.A ? newPoints.b : newPoints.a; await tx.sessionPlayer.update({ where: { id: participant.sessionPlayerId }, data: { wins: { increment: Number(isWinner) - Number(wasWinner) }, losses: { increment: Number(!isWinner) - Number(!wasWinner) }, pointsFor: { increment: newFor - oldFor }, pointsAgainst: { increment: newAgainst - oldAgainst }, version: { increment: 1 } } }); } await audit(tx, request, { sessionId: match.sessionId, action: "MATCH_SCORE_CORRECTED", entityType: "MATCH", entityId: match.id, reason: body.reason, before: { revision: prior.revisionNumber }, after: { revision: next.revisionNumber, winnerTeam } }); return next; });
  responseData(response, revision, 201);
}));

const skillValues = Object.values(SkillLevel) as [string, ...string[]];
const genderValues = Object.values(Gender) as [string, ...string[]];
const modeValues = Object.values(MatchmakingMode) as [string, ...string[]];
const idSchema = z.string().uuid();

const getAuth = (request: Request) => {
  const auth = (request as AuthenticatedRequest).auth;
  if (!auth) throw unauthorized();
  return auth;
};

const parse = <T>(schema: z.ZodType<T>, value: unknown) => {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest("The request is invalid.", result.error.flatten());
  return result.data;
};

const responseData = (response: Response, data: unknown, status = 200, meta?: unknown) => response.status(status).json({ data, ...(meta === undefined ? {} : { meta }), requestId: response.locals.requestId });
const noContent = (response: Response) => response.status(204).end();
const authUser = (request: Request) => getAuth(request).queueMaster;
const ownerWhere = (request: Request, id: string) => ({ id, queueMasterId: authUser(request).id });
const versionFrom = (request: Request) => {
  const value = request.get("if-match")?.replace(/\"/g, "");
  return value ? Number(value) : undefined;
};
const assertVersion = (actual: number, expected?: number) => {
  if (expected !== undefined && actual !== expected) throw conflict("VERSION_CONFLICT", "The record changed on another device.", { expected, actual });
};
async function audit(tx: Prisma.TransactionClient | typeof prisma, request: Request, values: { sessionId?: string; action: string; entityType: string; entityId: string; reason?: string; before?: unknown; after?: unknown }) {
  const auth = getAuth(request);
  await tx.auditLog.create({ data: { queueMasterId: auth.queueMaster.id, sessionId: values.sessionId, action: values.action, entityType: values.entityType, entityId: values.entityId, reason: values.reason, beforeJson: values.before as Prisma.InputJsonValue | undefined, afterJson: values.after as Prisma.InputJsonValue | undefined, requestId: String(request.id) } });
}

function scoreSettings(session: { pointsToWin: number; winBy: number; scoreCap: number | null; bestOf: number }) {
  return { pointsToWin: session.pointsToWin, winBy: session.winBy, scoreCap: session.scoreCap, bestOf: session.bestOf };
}

function sessionSummary(session: any) {
  return { id: session.id, name: session.name, sessionDate: session.sessionDate, status: session.status, startedAt: session.startedAt, endedAt: session.endedAt, scoring: scoreSettings(session), minimumRestMinutes: session.minimumRestMinutes, version: session.version, playerCount: session._count?.players ?? undefined, courtCount: session._count?.courts ?? undefined };
}

function playerView(player: any) {
  return { id: player.id, displayName: player.displayName, gender: player.gender, skillLevel: player.skillLevel, skillWeight: player.skillWeight, status: player.status, archivedAt: player.archivedAt, version: player.version, createdAt: player.createdAt, updatedAt: player.updatedAt };
}

function sessionPlayerView(player: any) {
  return { id: player.id, playerId: player.playerId, displayName: player.displayNameSnapshot, gender: player.genderSnapshot, skillLevel: player.skillLevelSnapshot, skillWeight: player.skillWeightSnapshot, status: player.status, queueEnteredAt: player.queueEnteredAt, lastMatchEndedAt: player.lastMatchEndedAt, matchesPlayed: player.matchesPlayed, wins: player.wins, losses: player.losses, pointsFor: player.pointsFor, pointsAgainst: player.pointsAgainst, amountDueMinor: player.amountDueMinor, manualPriority: player.manualPriority, currentMatchId: player.currentMatchId, version: player.version };
}

function matchView(match: any) {
  return { id: match.id, sessionId: match.sessionId, courtId: match.courtId, status: match.status, source: match.source, matchmakingMode: match.matchmakingMode, queuedAt: match.queuedAt, startedAt: match.startedAt, completedAt: match.completedAt, cancelledAt: match.cancelledAt, cancellationReason: match.cancellationReason, winnerTeam: match.winnerTeam, suggestionExplanation: match.suggestionExplanation, version: match.version, participants: match.participants?.map((participant: any) => ({ id: participant.id, sessionPlayerId: participant.sessionPlayerId, team: participant.team, teamSlot: participant.teamSlot, displayName: participant.sessionPlayer?.displayNameSnapshot })) ?? [] };
}

const historyQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(15), search: z.string().max(100).default("") });
const historyQuery = (request: Request) => parse(historyQuerySchema, request.query);
function historyPagination(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

async function discardMatch(request: Request, matchId: string) {
  const match = await prisma.match.findFirst({
    where: { id: matchId, session: { queueMasterId: authUser(request).id } },
    include: { participants: { include: { sessionPlayer: true } } },
  });
  if (!match) throw notFound("Match not found.");
  if (!([MatchStatus.QUEUED, MatchStatus.IN_PROGRESS] as MatchStatus[]).includes(match.status)) throw conflict("MATCH_NOT_CANCELLABLE", "Only queued or playing matches can be discarded.");
  const discardedAt = new Date();
  const snapshot = { ...match, status: MatchStatus.CANCELLED, cancelledAt: discardedAt, cancellationReason: "Discarded by Queue Master", updatedAt: discardedAt, version: match.version + 1 };
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.match.updateMany({ where: { id: match.id, status: { in: [MatchStatus.QUEUED, MatchStatus.IN_PROGRESS] } }, data: { status: MatchStatus.CANCELLED, cancelledAt: discardedAt, cancellationReason: "Discarded by Queue Master", version: { increment: 1 } } });
    if (claimed.count !== 1) throw conflict("MATCH_NOT_CANCELLABLE", "This match changed before it could be discarded.");
    if (match.courtId) await tx.sessionCourt.updateMany({ where: { id: match.courtId, sessionId: match.sessionId, currentMatchId: match.id }, data: { status: CourtStatus.AVAILABLE, currentMatchId: null, version: { increment: 1 } } });
    const participantIds = match.participants.map((participant) => participant.sessionPlayerId);
    const restoredPlayers = await tx.sessionPlayer.findMany({ where: { id: { in: participantIds }, sessionId: match.sessionId }, select: { id: true, queueEnteredAt: true, status: true, currentMatchId: true } });
    const restoredById = new Map(restoredPlayers.map((player) => [player.id, player]));
    for (const participant of match.participants) {
      const current = restoredById.get(participant.sessionPlayerId);
      const queueEnteredAt = participant.priorQueueEnteredAt ?? current?.queueEnteredAt ?? discardedAt;
      const restored = await tx.sessionPlayer.updateMany({ where: { id: participant.sessionPlayerId, sessionId: match.sessionId, status: { in: [SessionPlayerStatus.QUEUED, SessionPlayerStatus.PLAYING] }, OR: [{ currentMatchId: match.id }, { currentMatchId: null }, { currentMatchId: { isSet: false } }] }, data: { status: SessionPlayerStatus.WAITING, currentMatchId: null, queueEnteredAt, version: { increment: 1 } } });
      if (restored.count !== 1) throw conflict("PLAYER_LOCK_CONFLICT", "A player lock changed before this match could be discarded.");
    }
    const revisions = await tx.matchScoreRevision.findMany({ where: { matchId: match.id }, select: { id: true } });
    if (revisions.length) {
      await tx.matchGame.deleteMany({ where: { scoreRevisionId: { in: revisions.map((revision) => revision.id) } } });
      await tx.matchScoreRevision.deleteMany({ where: { id: { in: revisions.map((revision) => revision.id) } } });
    }
    await tx.matchParticipant.deleteMany({ where: { matchId: match.id } });
    await tx.idempotencyRecord.deleteMany({ where: { resultId: match.id } });
    await audit(tx, request, { sessionId: match.sessionId, action: "MATCH_DISCARDED", entityType: "MATCH", entityId: match.id, reason: "Discarded by Queue Master", before: { status: match.status, courtId: match.courtId, source: match.source, createdAt: match.createdAt?.toISOString(), updatedAt: match.updatedAt?.toISOString(), queuedAt: match.queuedAt?.toISOString(), startedAt: match.startedAt?.toISOString(), teams: { teamA: match.participants.filter((participant) => participant.team === TeamSide.A).map((participant) => ({ sessionPlayerId: participant.sessionPlayerId, teamSlot: participant.teamSlot })), teamB: match.participants.filter((participant) => participant.team === TeamSide.B).map((participant) => ({ sessionPlayerId: participant.sessionPlayerId, teamSlot: participant.teamSlot })) }, participants: match.participants.map((participant) => ({ sessionPlayerId: participant.sessionPlayerId, team: participant.team, teamSlot: participant.teamSlot })) }, after: { status: MatchStatus.CANCELLED, discardedAt: discardedAt.toISOString() } });
    await tx.match.delete({ where: { id: match.id } });
    await tx.queueSession.update({ where: { id: match.sessionId }, data: { matchmakingRevision: { increment: 1 }, version: { increment: 1 } } });
  });
  return snapshot;
}

function signSuggestion(payload: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", config.suggestionSigningSecret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifySuggestion(value: string) {
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature) throw conflict("SUGGESTION_STALE", "The suggestion is no longer valid.");
  const expected = createHmac("sha256", config.suggestionSigningSecret).update(encoded).digest("base64url");
  if (signature !== expected) throw conflict("SUGGESTION_STALE", "The suggestion is no longer valid.");
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw conflict("SUGGESTION_STALE", "The suggestion is no longer valid.");
  }
}

async function buildHistory(sessionId: string): Promise<MatchHistory> {
  const completed = await prisma.match.findMany({ where: { sessionId, status: MatchStatus.COMPLETED }, orderBy: [{ completedAt: "desc" }, { queuedAt: "desc" }], include: { participants: true } });
  const partners = new Map<string, Map<string, number>>();
  const opponents = new Map<string, Map<string, number>>();
  const encounters = new Map<string, Map<string, number>>();
  const recentPartners = new Map<string, Map<string, number>>();
  const recentOpponents = new Map<string, Map<string, number>>();
  const recentEncounters = new Map<string, Map<string, number>>();
  const quartets = new Map<string, number>();
  const recentQuartets = new Map<string, number>();
  const recentMatchCounts = new Map<string, number>();
  const increment = (map: Map<string, Map<string, number>>, a: string, b: string) => { const row = map.get(a) ?? new Map<string, number>(); row.set(b, (row.get(b) ?? 0) + 1); map.set(a, row); };
  const incrementPair = (map: Map<string, Map<string, number>>, a: string, b: string) => { increment(map, a, b); increment(map, b, a); };
  for (const match of completed) {
    const participants = match.participants;
    const key = participants.map((p) => p.sessionPlayerId).sort().join(":");
    quartets.set(key, (quartets.get(key) ?? 0) + 1);
    const recentParticipants = new Set(participants.filter((participant) => (recentMatchCounts.get(participant.sessionPlayerId) ?? 0) < 3).map((participant) => participant.sessionPlayerId));
    if (recentParticipants.size === participants.length) recentQuartets.set(key, (recentQuartets.get(key) ?? 0) + 1);
    for (let left = 0; left < participants.length; left += 1) {
      for (let right = left + 1; right < participants.length; right += 1) {
        const first = participants[left]!;
        const second = participants[right]!;
        incrementPair(encounters, first.sessionPlayerId, second.sessionPlayerId);
        if (first.team === second.team) incrementPair(partners, first.sessionPlayerId, second.sessionPlayerId);
        else incrementPair(opponents, first.sessionPlayerId, second.sessionPlayerId);
        if (recentParticipants.has(first.sessionPlayerId) || recentParticipants.has(second.sessionPlayerId)) {
          incrementPair(recentEncounters, first.sessionPlayerId, second.sessionPlayerId);
          if (first.team === second.team) incrementPair(recentPartners, first.sessionPlayerId, second.sessionPlayerId);
          else incrementPair(recentOpponents, first.sessionPlayerId, second.sessionPlayerId);
        }
      }
    }
    for (const participant of participants) recentMatchCounts.set(participant.sessionPlayerId, (recentMatchCounts.get(participant.sessionPlayerId) ?? 0) + 1);
  }
  return { partners, opponents, quartets, encounters, recentPartners, recentOpponents, recentEncounters, recentQuartets };
}

async function rebuildCareerStats(tx: Prisma.TransactionClient, queueMasterId: string) {
  await tx.playerCareerStat.deleteMany({ where: { queueMasterId } });
  const matches = await tx.match.findMany({
    where: { session: { queueMasterId }, status: MatchStatus.COMPLETED },
    include: { participants: { include: { sessionPlayer: true } }, scoreRevisions: { include: { games: true } } },
    orderBy: [{ completedAt: "asc" }, { createdAt: "asc" }],
  });
  const stats = new Map<string, { matchesPlayed: number; wins: number; losses: number; pointsFor: number; pointsAgainst: number; currentStreak: number; lastPlayedAt: Date | null }>();
  for (const match of matches) {
    const revision = match.scoreRevisions.find((item) => item.id === match.currentRevisionId) ?? match.scoreRevisions[match.scoreRevisions.length - 1];
    if (!revision) continue;
    const points = revision.games.reduce((sum, game) => ({ a: sum.a + game.teamAScore, b: sum.b + game.teamBScore }), { a: 0, b: 0 });
    const playedAt = match.completedAt ?? match.updatedAt;
    for (const participant of match.participants) {
      const playerId = participant.sessionPlayer.playerId;
      const row = stats.get(playerId) ?? { matchesPlayed: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, currentStreak: 0, lastPlayedAt: null };
      const won = participant.team === revision.winnerTeam;
      row.matchesPlayed += 1;
      row.wins += won ? 1 : 0;
      row.losses += won ? 0 : 1;
      row.pointsFor += participant.team === TeamSide.A ? points.a : points.b;
      row.pointsAgainst += participant.team === TeamSide.A ? points.b : points.a;
      row.currentStreak = won ? (row.currentStreak >= 0 ? row.currentStreak + 1 : 1) : (row.currentStreak <= 0 ? row.currentStreak - 1 : -1);
      row.lastPlayedAt = playedAt;
      stats.set(playerId, row);
    }
  }
  await Promise.all([...stats.entries()].map(([playerId, row]) => tx.playerCareerStat.create({ data: { queueMasterId, playerId, ...row, pointDifferential: row.pointsFor - row.pointsAgainst, winRateBasisPoints: Math.floor((row.wins * 10000) / row.matchesPlayed) } })));
}

type PlayerDeletionDb = Prisma.TransactionClient;

async function loadPlayerDeletionPreview(tx: PlayerDeletionDb, queueMasterId: string, playerIds: string[]) {
  const uniqueIds = [...new Set(playerIds)];
  const players = await tx.player.findMany({ where: { queueMasterId, id: { in: uniqueIds } }, select: { id: true, displayName: true } });
  if (players.length !== uniqueIds.length) throw notFound("One or more players were not found.");
  const sessionPlayers = await tx.sessionPlayer.findMany({ where: { playerId: { in: uniqueIds }, session: { queueMasterId } }, select: { id: true, playerId: true, displayNameSnapshot: true, status: true, sessionId: true } });
  const sessionPlayerIds = sessionPlayers.map((player) => player.id);
  const matches = sessionPlayerIds.length ? await tx.match.findMany({ where: { session: { queueMasterId }, participants: { some: { sessionPlayerId: { in: sessionPlayerIds } } } }, select: { id: true, sessionId: true, status: true, participants: { select: { sessionPlayerId: true, sessionPlayer: { select: { playerId: true } } } } } }) : [];
  const payments = sessionPlayerIds.length ? await tx.payment.findMany({ where: { sessionPlayerId: { in: sessionPlayerIds }, session: { queueMasterId } }, select: { id: true, sessionId: true, sessionPlayerId: true } }) : [];
  const sessionIds = [...new Set([...sessionPlayers.map((player) => player.sessionId), ...matches.map((match) => match.sessionId)])];
  const affectedSessions = sessionIds.length ? await tx.queueSession.findMany({ where: { id: { in: sessionIds }, queueMasterId }, select: { id: true, name: true, status: true } }) : [];
  const selected = new Set(sessionPlayerIds);
  const otherSessionPlayerIds = [...new Set(matches.flatMap((match) => match.participants.map((participant) => participant.sessionPlayerId)).filter((idValue) => !selected.has(idValue)))];
  const otherParticipants = otherSessionPlayerIds.length ? await tx.sessionPlayer.findMany({ where: { id: { in: otherSessionPlayerIds } }, select: { id: true, playerId: true } }) : [];
  return {
    playerIds: uniqueIds,
    playerNames: players.sort((a, b) => a.displayName.localeCompare(b.displayName)).map((player) => player.displayName),
    busyPlayers: sessionPlayers.filter((player) => player.status === SessionPlayerStatus.QUEUED || player.status === SessionPlayerStatus.PLAYING).map((player) => ({ playerId: player.playerId, sessionPlayerId: player.id, displayName: player.displayNameSnapshot, sessionId: player.sessionId, status: player.status })),
    affectedSessionIds: sessionIds,
    affectedSessions,
    affectedMatchIds: matches.map((match) => match.id),
    affectedPaymentIds: payments.map((payment) => payment.id),
    otherParticipantPlayerIds: [...new Set(otherParticipants.map((participant) => participant.playerId))],
    otherParticipantSessionPlayerIds: otherSessionPlayerIds,
    affectedMatchCount: matches.length,
    affectedPaymentCount: payments.length,
  };
}

async function rebuildSessionStats(tx: PlayerDeletionDb, sessionIds: string[]) {
  const ids = [...new Set(sessionIds)];
  for (const sessionId of ids) {
    await tx.sessionPlayer.updateMany({ where: { sessionId }, data: { matchesPlayed: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, lastMatchEndedAt: null, version: { increment: 1 } } });
    const matches = await tx.match.findMany({ where: { sessionId, status: MatchStatus.COMPLETED }, include: { participants: true, scoreRevisions: { include: { games: true } } }, orderBy: [{ completedAt: "asc" }, { createdAt: "asc" }] });
    for (const match of matches) {
      const revision = match.scoreRevisions.find((item) => item.id === match.currentRevisionId) ?? match.scoreRevisions.sort((a, b) => b.revisionNumber - a.revisionNumber)[0];
      if (!revision) continue;
      const points = revision.games.reduce((sum, game) => ({ a: sum.a + game.teamAScore, b: sum.b + game.teamBScore }), { a: 0, b: 0 });
      for (const participant of match.participants) {
        const pointsFor = participant.team === TeamSide.A ? points.a : points.b;
        const pointsAgainst = participant.team === TeamSide.A ? points.b : points.a;
        const won = participant.team === revision.winnerTeam;
        await tx.sessionPlayer.update({ where: { id: participant.sessionPlayerId }, data: { matchesPlayed: { increment: 1 }, wins: { increment: won ? 1 : 0 }, losses: { increment: won ? 0 : 1 }, pointsFor: { increment: pointsFor }, pointsAgainst: { increment: pointsAgainst }, lastMatchEndedAt: match.completedAt ?? null, version: { increment: 1 } } });
      }
    }
    const config = await tx.sessionFeeConfig.findUnique({ where: { sessionId } });
    if (config?.mode === FeeMode.EQUAL_SPLIT) {
      const roster = await tx.sessionPlayer.findMany({ where: { sessionId }, select: { id: true } });
      const allocations = allocateEqualSplit(config.expectedSessionCostMinor ?? 0, roster.map((player) => player.id));
      for (const player of roster) await tx.sessionPlayer.update({ where: { id: player.id }, data: { amountDueMinor: allocations.get(player.id) ?? 0 } });
    }
  }
}

async function deletePlayersInTransaction(tx: PlayerDeletionDb, request: Request, queueMasterId: string, playerIds: string[]) {
  const impact = await loadPlayerDeletionPreview(tx, queueMasterId, playerIds);
  if (impact.busyPlayers.length) throw conflict("PLAYER_BUSY", "Queued or playing players cannot be deleted.", { busyPlayers: impact.busyPlayers });
  const selectedSessionPlayerIds = [...new Set((await tx.sessionPlayer.findMany({ where: { playerId: { in: impact.playerIds }, session: { queueMasterId } }, select: { id: true } })).map((player) => player.id))];
  const matchIds = impact.affectedMatchIds;
  const revisionIds = matchIds.length ? (await tx.matchScoreRevision.findMany({ where: { matchId: { in: matchIds } }, select: { id: true } })).map((revision) => revision.id) : [];
  const relatedPayments = impact.affectedPaymentIds.length ? await tx.payment.findMany({ where: { session: { queueMasterId }, OR: [{ id: { in: impact.affectedPaymentIds } }, { reversalOfPaymentId: { in: impact.affectedPaymentIds } }] }, select: { id: true } }) : [];
  const paymentIds = relatedPayments.map((payment) => payment.id);
  const relatedIds = [...impact.playerIds, ...selectedSessionPlayerIds, ...matchIds, ...revisionIds, ...paymentIds];
  if (revisionIds.length) await tx.matchGame.deleteMany({ where: { scoreRevisionId: { in: revisionIds } } });
  if (matchIds.length) {
    await tx.matchScoreRevision.deleteMany({ where: { matchId: { in: matchIds } } });
    await tx.matchParticipant.deleteMany({ where: { matchId: { in: matchIds } } });
    await tx.match.deleteMany({ where: { id: { in: matchIds } } });
  }
  if (paymentIds.length) await tx.payment.deleteMany({ where: { id: { in: paymentIds } } });
  await tx.idempotencyRecord.deleteMany({ where: { queueMasterId, resultId: { in: relatedIds } } });
  if (selectedSessionPlayerIds.length) await tx.sessionPlayer.deleteMany({ where: { id: { in: selectedSessionPlayerIds } } });
  await tx.playerCareerStat.deleteMany({ where: { queueMasterId, playerId: { in: impact.playerIds } } });
  await tx.player.deleteMany({ where: { queueMasterId, id: { in: impact.playerIds } } });
  for (const sessionId of impact.affectedSessionIds) await tx.queueSession.update({ where: { id: sessionId }, data: { matchmakingRevision: { increment: 1 }, version: { increment: 1 } } });
  await rebuildSessionStats(tx, impact.affectedSessionIds);
  await rebuildCareerStats(tx, queueMasterId);
  await audit(tx, request, { entityType: "ACCOUNT", entityId: queueMasterId, action: "PLAYERS_DELETED", reason: "Permanent player deletion", before: { playerIds: impact.playerIds, playerNames: impact.playerNames, affectedSessionIds: impact.affectedSessionIds, affectedMatchCount: impact.affectedMatchIds.length, affectedPaymentCount: impact.affectedPaymentIds.length }, after: { deletedPlayerIds: impact.playerIds, cascadeCompleted: true } });
  return { deletedPlayerIds: impact.playerIds, affectedSessionIds: impact.affectedSessionIds, affectedMatchCount: impact.affectedMatchIds.length, affectedPaymentCount: impact.affectedPaymentIds.length, otherParticipantPlayerIds: impact.otherParticipantPlayerIds };
}

async function clearSessionHistory(tx: Prisma.TransactionClient, sessionId: string, queueMasterId: string) {
  const matches = await tx.match.findMany({ where: { sessionId }, select: { id: true } });
  const matchIds = matches.map((match) => match.id);
  const revisions = matchIds.length ? await tx.matchScoreRevision.findMany({ where: { matchId: { in: matchIds } }, select: { id: true } }) : [];
  const payments = await tx.payment.findMany({ where: { sessionId }, select: { id: true } });
  const sessionPlayers = await tx.sessionPlayer.findMany({ where: { sessionId }, select: { id: true } });
  const courts = await tx.sessionCourt.findMany({ where: { sessionId }, select: { id: true } });
  const revisionIds = revisions.map((revision) => revision.id);
  const relatedIds = [sessionId, ...matchIds, ...revisionIds, ...payments.map((payment) => payment.id), ...sessionPlayers.map((player) => player.id), ...courts.map((court) => court.id)];
  if (revisionIds.length) await tx.matchGame.deleteMany({ where: { scoreRevisionId: { in: revisionIds } } });
  if (matchIds.length) {
    await tx.matchScoreRevision.deleteMany({ where: { matchId: { in: matchIds } } });
    await tx.matchParticipant.deleteMany({ where: { matchId: { in: matchIds } } });
    await tx.match.deleteMany({ where: { id: { in: matchIds } } });
  }
  await tx.payment.deleteMany({ where: { sessionId } });
  await tx.idempotencyRecord.deleteMany({ where: { queueMasterId, resultId: { in: relatedIds } } });
}

async function getOwnedSession(request: Request, sessionId: string) {
  const session = await prisma.queueSession.findFirst({ where: { id: sessionId, queueMasterId: authUser(request).id } });
  if (!session) throw notFound("Session not found.");
  return session;
}

async function buildCloudSnapshot(queueMasterId: string, db: typeof prisma = prisma): Promise<CloudSnapshotV1> {
  const [settings, players, sessions, sessionPlayers, courts, matches, feeConfigs, payments, audits, careerStats] = await Promise.all([
    db.queueMasterSettings.findUnique({ where: { queueMasterId } }),
    db.player.findMany({ where: { queueMasterId } }),
    db.queueSession.findMany({ where: { queueMasterId } }),
    db.sessionPlayer.findMany({ where: { session: { queueMasterId } } }),
    db.sessionCourt.findMany({ where: { session: { queueMasterId } } }),
    db.match.findMany({ where: { session: { queueMasterId } }, include: { participants: true, scoreRevisions: { include: { games: true } } } }),
    db.sessionFeeConfig.findMany({ where: { session: { queueMasterId } } }),
    db.payment.findMany({ where: { session: { queueMasterId } } }),
    db.auditLog.findMany({ where: { queueMasterId }, orderBy: { createdAt: "asc" }, take: 10000 }),
    db.playerCareerStat.findMany({ where: { queueMasterId } }),
  ]);
  const iso = (value: Date | null | undefined) => value ? value.toISOString() : null;
  return {
    schemaVersion: 1,
    queueMasterId,
    settings: settings ? { id: settings.id, pointsToWin: settings.pointsToWin, winBy: settings.winBy, scoreCap: settings.scoreCap, bestOf: settings.bestOf as 1 | 3, minimumRestMinutes: settings.minimumRestMinutes, defaultFeeMode: settings.defaultFeeMode, defaultFixedFeeMinor: settings.defaultFixedFeeMinor, currencyCode: settings.currencyCode, timeZone: settings.timeZone, version: settings.version } : null,
    players: players.map((player) => ({ id: player.id, displayName: player.displayName, gender: player.gender, skillLevel: player.skillLevel, skillWeight: player.skillWeight, status: player.status })),
    sessions: sessions.map((session) => ({ id: session.id, name: session.name, normalizedName: session.normalizedName, sessionDate: session.sessionDate.toISOString(), status: session.status, startedAt: iso(session.startedAt), endedAt: iso(session.endedAt), cancelledAt: iso(session.cancelledAt), pointsToWin: session.pointsToWin, winBy: session.winBy, scoreCap: session.scoreCap, bestOf: session.bestOf as 1 | 3, minimumRestMinutes: session.minimumRestMinutes, matchmakingAlgorithm: session.matchmakingAlgorithm, matchmakingRevision: session.matchmakingRevision, version: session.version })),
    sessionPlayers: sessionPlayers.map((player) => ({ id: player.id, sessionId: player.sessionId, playerId: player.playerId, displayName: player.displayNameSnapshot, gender: player.genderSnapshot, skillLevel: player.skillLevelSnapshot, skillWeight: player.skillWeightSnapshot, status: player.status, queueEnteredAt: iso(player.queueEnteredAt), lastMatchEndedAt: iso(player.lastMatchEndedAt), matchesPlayed: player.matchesPlayed, wins: player.wins, losses: player.losses, pointsFor: player.pointsFor, pointsAgainst: player.pointsAgainst, amountDueMinor: player.amountDueMinor, manualPriority: player.manualPriority, priorityReason: player.priorityReason, currentMatchId: player.currentMatchId, checkedInAt: iso(player.checkedInAt), checkedOutAt: iso(player.checkedOutAt), restStartedAt: iso(player.restStartedAt), version: player.version })),
    courts: courts.map((court) => ({ id: court.id, sessionId: court.sessionId, name: court.name, normalizedName: court.normalizedName, displayOrder: court.displayOrder, status: court.status, currentMatchId: court.currentMatchId, closedAt: iso(court.closedAt), version: court.version })),
    matches: matches.map((match) => ({ id: match.id, sessionId: match.sessionId, courtId: match.courtId, status: match.status, source: match.source, matchmakingMode: match.matchmakingMode, algorithmVersion: match.algorithmVersion, suggestionKey: match.suggestionKey, suggestionExplanation: match.suggestionExplanation, queuedAt: match.queuedAt.toISOString(), startedAt: iso(match.startedAt), completedAt: iso(match.completedAt), cancelledAt: iso(match.cancelledAt), cancellationReason: match.cancellationReason, winnerTeam: match.winnerTeam, currentRevisionId: match.currentRevisionId, version: match.version, participants: match.participants.map((participant) => ({ id: participant.id, matchId: participant.matchId, sessionPlayerId: participant.sessionPlayerId, team: participant.team, teamSlot: participant.teamSlot, priorQueueEnteredAt: iso(participant.priorQueueEnteredAt) })), scoreRevisions: match.scoreRevisions.map((revision) => ({ id: revision.id, matchId: revision.matchId, revisionNumber: revision.revisionNumber, winnerTeam: revision.winnerTeam, reason: revision.reason, supersedesRevisionId: revision.supersedesRevisionId, createdAt: revision.createdAt.toISOString(), games: revision.games.map((game) => ({ id: game.id, scoreRevisionId: game.scoreRevisionId, gameNumber: game.gameNumber, teamAScore: game.teamAScore, teamBScore: game.teamBScore, winnerTeam: game.winnerTeam })) })) })),
    feeConfigs: feeConfigs.map((fee) => ({ id: fee.id, sessionId: fee.sessionId, mode: fee.mode, currencyCode: fee.currencyCode, fixedAmountPerPlayerMinor: fee.fixedAmountPerPlayerMinor, expectedSessionCostMinor: fee.expectedSessionCostMinor, participationRule: fee.participationRule, frozenAt: iso(fee.frozenAt), version: fee.version })),
    payments: payments.map((payment) => ({ id: payment.id, sessionId: payment.sessionId, sessionPlayerId: payment.sessionPlayerId, kind: payment.kind, method: payment.method, amountMinor: payment.amountMinor, reference: payment.reference, note: payment.note, reversalOfPaymentId: payment.reversalOfPaymentId, recordedById: payment.recordedById, occurredAt: payment.occurredAt.toISOString(), createdAt: payment.createdAt.toISOString() })),
    audits: audits.map((auditRecord) => ({ id: auditRecord.id, sessionId: auditRecord.sessionId, action: auditRecord.action, entityType: auditRecord.entityType, entityId: auditRecord.entityId, reason: auditRecord.reason, beforeJson: auditRecord.beforeJson, afterJson: auditRecord.afterJson, requestId: auditRecord.requestId, createdAt: auditRecord.createdAt.toISOString() })),
    careerStats: careerStats.map((stat) => ({ id: stat.id, playerId: stat.playerId, matchesPlayed: stat.matchesPlayed, wins: stat.wins, losses: stat.losses, pointsFor: stat.pointsFor, pointsAgainst: stat.pointsAgainst, pointDifferential: stat.pointDifferential, winRateBasisPoints: stat.winRateBasisPoints, currentStreak: stat.currentStreak, lastPlayedAt: iso(stat.lastPlayedAt), version: stat.version })),
  };
}

const cloudDate = z.string().min(1).refine((value) => !Number.isNaN(Date.parse(value)), "The snapshot contains an invalid date.");
const cloudNullableDate = cloudDate.nullable();
const cloudAmount = z.number().int().min(0).max(2_000_000_000);
const cloudSkill = z.enum(skillValues);
const cloudGender = z.enum(genderValues);
const cloudSessionStatus = z.enum(Object.values(SessionStatus) as [string, ...string[]]);
const cloudPlayerStatus = z.enum(Object.values(PlayerStatus) as [string, ...string[]]);
const cloudSessionPlayerStatus = z.enum(Object.values(SessionPlayerStatus) as [string, ...string[]]);
const cloudCourtStatus = z.enum(Object.values(CourtStatus) as [string, ...string[]]);
const cloudMatchStatus = z.enum(Object.values(MatchStatus) as [string, ...string[]]);
const cloudMatchSource = z.enum(Object.values(MatchSource) as [string, ...string[]]);
const cloudMatchMode = z.enum(modeValues).nullable().optional();
const cloudTeam = z.enum([TeamSide.A, TeamSide.B]);

const cloudSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  queueMasterId: idSchema,
  settings: z.object({
    id: idSchema,
    pointsToWin: z.number().int().min(1).max(99),
    winBy: z.number().int().min(1).max(10),
    scoreCap: z.number().int().min(1).max(99).nullable(),
    bestOf: z.union([z.literal(1), z.literal(3)]),
    minimumRestMinutes: z.number().int().min(0).max(60),
    defaultFeeMode: z.enum([FeeMode.FIXED_PER_PLAYER, FeeMode.EQUAL_SPLIT]),
    defaultFixedFeeMinor: cloudAmount.nullable().optional(),
    currencyCode: z.string().min(3).max(3),
    timeZone: z.string().min(1).max(80),
    version: z.number().int().min(1),
  }).nullable(),
  players: z.array(z.object({
    id: idSchema,
    displayName: z.string().min(1).max(80),
    gender: cloudGender,
    skillLevel: cloudSkill,
    skillWeight: z.number().int().min(1).max(5),
    status: cloudPlayerStatus,
  })).max(100_000),
  sessions: z.array(z.object({
    id: idSchema,
    name: z.string().min(1).max(100),
    normalizedName: z.string().min(1).max(100),
    sessionDate: cloudDate,
    status: cloudSessionStatus,
    startedAt: cloudNullableDate,
    endedAt: cloudNullableDate,
    cancelledAt: cloudNullableDate,
    pointsToWin: z.number().int().min(1).max(99),
    winBy: z.number().int().min(1).max(10),
    scoreCap: z.number().int().min(1).max(99).nullable(),
    bestOf: z.union([z.literal(1), z.literal(3)]),
    minimumRestMinutes: z.number().int().min(0).max(60),
    matchmakingAlgorithm: z.string().min(1).max(80),
    matchmakingRevision: z.number().int().min(1),
    version: z.number().int().min(1),
  })).max(100_000),
  sessionPlayers: z.array(z.object({
    id: idSchema,
    sessionId: idSchema,
    playerId: idSchema,
    displayName: z.string().min(1).max(80),
    gender: cloudGender,
    skillLevel: cloudSkill,
    skillWeight: z.number().int().min(1).max(5),
    status: cloudSessionPlayerStatus,
    queueEnteredAt: cloudNullableDate,
    lastMatchEndedAt: cloudNullableDate,
    matchesPlayed: z.number().int().min(0).max(100_000),
    wins: z.number().int().min(0).max(100_000),
    losses: z.number().int().min(0).max(100_000),
    pointsFor: z.number().int().min(0).max(10_000_000),
    pointsAgainst: z.number().int().min(0).max(10_000_000),
    amountDueMinor: cloudAmount.optional(),
    manualPriority: z.number().int().min(-1).max(1).optional(),
    priorityReason: z.string().max(200).nullable().optional(),
    currentMatchId: idSchema.nullable().optional(),
    checkedInAt: cloudNullableDate,
    checkedOutAt: cloudNullableDate,
    restStartedAt: cloudNullableDate,
    version: z.number().int().min(1),
  })).max(100_000),
  courts: z.array(z.object({
    id: idSchema,
    sessionId: idSchema,
    name: z.string().min(1).max(60),
    normalizedName: z.string().min(1).max(60),
    displayOrder: z.number().int().min(0).max(100_000),
    status: cloudCourtStatus,
    currentMatchId: idSchema.nullable().optional(),
    closedAt: cloudNullableDate,
    version: z.number().int().min(1),
  })).max(100_000),
  matches: z.array(z.object({
    id: idSchema,
    sessionId: idSchema,
    courtId: idSchema.nullable().optional(),
    status: cloudMatchStatus,
    source: cloudMatchSource,
    matchmakingMode: cloudMatchMode,
    algorithmVersion: z.string().max(80).nullable().optional(),
    suggestionKey: z.string().max(200).nullable().optional(),
    suggestionExplanation: z.unknown().optional(),
    queuedAt: cloudDate,
    startedAt: cloudNullableDate,
    completedAt: cloudNullableDate,
    cancelledAt: cloudNullableDate,
    cancellationReason: z.string().max(200).nullable().optional(),
    winnerTeam: cloudTeam.nullable().optional(),
    currentRevisionId: idSchema.nullable().optional(),
    version: z.number().int().min(1),
    participants: z.array(z.object({ id: idSchema, matchId: idSchema, sessionPlayerId: idSchema, team: cloudTeam, teamSlot: z.number().int().min(1).max(2), priorQueueEnteredAt: cloudNullableDate })).max(4),
    scoreRevisions: z.array(z.object({
      id: idSchema,
      matchId: idSchema,
      revisionNumber: z.number().int().min(1),
      winnerTeam: cloudTeam,
      reason: z.string().max(300).nullable().optional(),
      supersedesRevisionId: idSchema.nullable().optional(),
      createdAt: cloudDate,
      games: z.array(z.object({ id: idSchema, scoreRevisionId: idSchema, gameNumber: z.number().int().min(1).max(3), teamAScore: z.number().int().min(0).max(99), teamBScore: z.number().int().min(0).max(99), winnerTeam: cloudTeam })).max(3),
    })).max(10_000),
  })).max(100_000),
  feeConfigs: z.array(z.object({ id: idSchema, sessionId: idSchema, mode: z.enum([FeeMode.FIXED_PER_PLAYER, FeeMode.EQUAL_SPLIT]), currencyCode: z.string().min(3).max(3), fixedAmountPerPlayerMinor: cloudAmount.nullable().optional(), expectedSessionCostMinor: cloudAmount.nullable().optional(), participationRule: z.string().min(1).max(80), frozenAt: cloudNullableDate, version: z.number().int().min(1) })).max(100_000),
  payments: z.array(z.object({ id: idSchema, sessionId: idSchema, sessionPlayerId: idSchema, kind: z.enum(Object.values(PaymentKind) as [string, ...string[]]), method: z.enum(Object.values(PaymentMethod) as [string, ...string[]]).nullable().optional(), amountMinor: z.number().int().positive().max(2_000_000_000), reference: z.string().max(120).nullable().optional(), note: z.string().max(500).nullable().optional(), reversalOfPaymentId: idSchema.nullable().optional(), recordedById: idSchema, occurredAt: cloudDate, createdAt: cloudDate })).max(100_000),
  audits: z.array(z.record(z.string(), z.unknown())).max(100_000),
  careerStats: z.array(z.record(z.string(), z.unknown())).max(100_000),
}).strict();

function validateCloudSnapshot(value: Record<string, unknown>, queueMasterId: string): CloudSnapshotV1 {
  const snapshot = parse(cloudSnapshotSchema, value) as unknown as CloudSnapshotV1;
  if (snapshot.queueMasterId !== queueMasterId) throw badRequest("The snapshot is not valid for this account.");
  if (snapshot.settings && snapshot.settings.scoreCap !== null && snapshot.settings.scoreCap < snapshot.settings.pointsToWin) throw badRequest("The snapshot contains invalid scoring settings.");
  for (const session of snapshot.sessions) if (session.scoreCap !== null && session.scoreCap < session.pointsToWin) throw badRequest("The snapshot contains invalid scoring settings.");
  for (const player of snapshot.players) if (player.skillWeight !== skillWeight(player.skillLevel)) throw badRequest("The snapshot contains an invalid skill weight.");
  for (const player of snapshot.sessionPlayers) if (player.skillWeight !== skillWeight(player.skillLevel)) throw badRequest("The snapshot contains an invalid skill weight.");

  const ids = new Set<string>();
  for (const collection of [snapshot.players, snapshot.sessions, snapshot.sessionPlayers, snapshot.courts, snapshot.matches, snapshot.feeConfigs, snapshot.payments]) {
    for (const item of collection) {
      if (!syncRecordId(item.id) || ids.has(item.id)) throw badRequest("The snapshot contains an invalid or duplicate record ID.");
      ids.add(item.id);
    }
  }
  const sessionIds = new Set(snapshot.sessions.map((item) => item.id));
  const playerIds = new Set(snapshot.players.map((item) => item.id));
  const sessionPlayerIds = new Set(snapshot.sessionPlayers.map((item) => item.id));
  const courtIds = new Set(snapshot.courts.map((item) => item.id));
  const matchIds = new Set(snapshot.matches.map((item) => item.id));
  const paymentIds = new Set(snapshot.payments.map((item) => item.id));
  const feeSessionIds = new Set<string>();
  for (const item of snapshot.sessionPlayers) if (!item.sessionId || !sessionIds.has(item.sessionId) || !playerIds.has(item.playerId)) throw badRequest("The snapshot contains an invalid relationship.");
  for (const item of snapshot.courts) if (!sessionIds.has(item.sessionId) || (item.currentMatchId && !matchIds.has(item.currentMatchId))) throw badRequest("The snapshot contains an invalid court relationship.");
  for (const item of snapshot.feeConfigs) if (!sessionIds.has(item.sessionId) || feeSessionIds.has(item.sessionId)) throw badRequest("The snapshot contains an invalid fee configuration."); else feeSessionIds.add(item.sessionId);
  for (const item of snapshot.payments) if (!sessionIds.has(item.sessionId) || !sessionPlayerIds.has(item.sessionPlayerId) || !snapshot.sessionPlayers.some((player) => player.id === item.sessionPlayerId && player.sessionId === item.sessionId) || (item.reversalOfPaymentId && !paymentIds.has(item.reversalOfPaymentId))) throw badRequest("The snapshot contains an invalid payment relationship.");
  for (const match of snapshot.matches) {
    const session = snapshot.sessions.find((item) => item.id === match.sessionId);
    if (!session || (match.courtId && (!courtIds.has(match.courtId) || !snapshot.courts.some((court) => court.id === match.courtId && court.sessionId === match.sessionId)))) throw badRequest("The snapshot contains an invalid match relationship.");
    if (match.participants.length !== 2 && match.participants.length !== 4) throw badRequest("The snapshot contains an invalid match lineup.");
    const participantIds = new Set<string>(); const slots = new Set<string>();
    for (const participant of match.participants) {
      if (participant.matchId !== match.id || participantIds.has(participant.id) || !sessionPlayerIds.has(participant.sessionPlayerId) || !snapshot.sessionPlayers.some((player) => player.id === participant.sessionPlayerId && player.sessionId === match.sessionId)) throw badRequest("The snapshot contains an invalid match participant.");
      participantIds.add(participant.id); const slot = `${participant.team}:${participant.teamSlot}`; if (slots.has(slot)) throw badRequest("The snapshot contains duplicate match slots."); slots.add(slot);
    }
    const teamACount = match.participants.filter((participant) => participant.team === TeamSide.A).length; const teamBCount = match.participants.filter((participant) => participant.team === TeamSide.B).length;
    if (teamACount !== teamBCount || (teamACount !== 1 && teamACount !== 2)) throw badRequest("The snapshot contains an invalid match lineup.");
    const revisionIds = new Set<string>();
    for (const revision of match.scoreRevisions) {
      if (revision.matchId !== match.id || revisionIds.has(revision.id) || revision.games.some((game) => game.scoreRevisionId !== revision.id)) throw badRequest("The snapshot contains an invalid score revision.");
      revisionIds.add(revision.id);
      try { validateScores(revision.games.map((game) => ({ teamAScore: game.teamAScore, teamBScore: game.teamBScore })), scoreSettings(session)); } catch { throw badRequest("The snapshot contains invalid score data."); }
    }
    if (match.currentRevisionId && !revisionIds.has(match.currentRevisionId)) throw badRequest("The snapshot contains an invalid current score revision.");
  }
  for (const player of snapshot.sessionPlayers) if (player.currentMatchId && (!matchIds.has(player.currentMatchId) || !snapshot.matches.some((match) => match.id === player.currentMatchId && match.participants.some((participant) => participant.sessionPlayerId === player.id)))) throw badRequest("The snapshot contains an invalid player match relationship.");
  return snapshot;
}

async function replaceCloudSnapshot(tx: Prisma.TransactionClient, queueMasterId: string, snapshot: CloudSnapshotV1) {
  const existingSessions = await tx.queueSession.findMany({ where: { queueMasterId }, select: { id: true } });
  const existingSessionIds = existingSessions.map((item) => item.id);
  const existingMatches = existingSessionIds.length ? await tx.match.findMany({ where: { sessionId: { in: existingSessionIds } }, select: { id: true } }) : [];
  const existingMatchIds = existingMatches.map((item) => item.id);
  const existingRevisions = existingMatchIds.length ? await tx.matchScoreRevision.findMany({ where: { matchId: { in: existingMatchIds } }, select: { id: true } }) : [];
  const existingRevisionIds = existingRevisions.map((item) => item.id);
  if (existingRevisionIds.length) await tx.matchGame.deleteMany({ where: { scoreRevisionId: { in: existingRevisionIds } } });
  if (existingMatchIds.length) { await tx.matchScoreRevision.deleteMany({ where: { matchId: { in: existingMatchIds } } }); await tx.matchParticipant.deleteMany({ where: { matchId: { in: existingMatchIds } } }); await tx.match.deleteMany({ where: { id: { in: existingMatchIds } } }); }
  if (existingSessionIds.length) { await tx.payment.deleteMany({ where: { sessionId: { in: existingSessionIds } } }); await tx.sessionFeeConfig.deleteMany({ where: { sessionId: { in: existingSessionIds } } }); await tx.sessionCourt.deleteMany({ where: { sessionId: { in: existingSessionIds } } }); await tx.sessionPlayer.deleteMany({ where: { sessionId: { in: existingSessionIds } } }); await tx.queueSession.deleteMany({ where: { id: { in: existingSessionIds } } }); }
  await tx.playerCareerStat.deleteMany({ where: { queueMasterId } });
  await tx.player.deleteMany({ where: { queueMasterId } });
  if (snapshot.settings) await tx.queueMasterSettings.upsert({ where: { queueMasterId }, create: { queueMasterId, pointsToWin: snapshot.settings.pointsToWin, winBy: snapshot.settings.winBy, scoreCap: snapshot.settings.scoreCap, bestOf: snapshot.settings.bestOf, minimumRestMinutes: snapshot.settings.minimumRestMinutes, defaultFeeMode: snapshot.settings.defaultFeeMode as FeeMode, defaultFixedFeeMinor: snapshot.settings.defaultFixedFeeMinor, currencyCode: snapshot.settings.currencyCode, timeZone: snapshot.settings.timeZone }, update: { pointsToWin: snapshot.settings.pointsToWin, winBy: snapshot.settings.winBy, scoreCap: snapshot.settings.scoreCap, bestOf: snapshot.settings.bestOf, minimumRestMinutes: snapshot.settings.minimumRestMinutes, defaultFeeMode: snapshot.settings.defaultFeeMode as FeeMode, defaultFixedFeeMinor: snapshot.settings.defaultFixedFeeMinor, currencyCode: snapshot.settings.currencyCode, timeZone: snapshot.settings.timeZone } });
  for (const player of snapshot.players) await tx.player.create({ data: { id: player.id, queueMasterId, displayName: player.displayName, normalizedName: normalizeName(player.displayName), gender: player.gender as Gender, skillLevel: player.skillLevel as SkillLevel, skillWeight: player.skillWeight, status: player.status as PlayerStatus } });
  for (const session of snapshot.sessions) await tx.queueSession.create({ data: { id: session.id, queueMasterId, name: session.name, normalizedName: session.normalizedName, sessionDate: new Date(session.sessionDate), status: session.status as SessionStatus, startedAt: session.startedAt ? new Date(session.startedAt) : null, endedAt: session.endedAt ? new Date(session.endedAt) : null, cancelledAt: session.cancelledAt ? new Date(session.cancelledAt) : null, pointsToWin: session.pointsToWin, winBy: session.winBy, scoreCap: session.scoreCap, bestOf: session.bestOf, minimumRestMinutes: session.minimumRestMinutes, matchmakingAlgorithm: session.matchmakingAlgorithm, matchmakingRevision: session.matchmakingRevision, version: session.version } });
  for (const player of snapshot.sessionPlayers) await tx.sessionPlayer.create({ data: { id: player.id, sessionId: String(player.sessionId), playerId: player.playerId, displayNameSnapshot: player.displayName, normalizedNameSnapshot: normalizeName(player.displayName), genderSnapshot: player.gender as Gender, skillLevelSnapshot: player.skillLevel as SkillLevel, skillWeightSnapshot: player.skillWeight, status: player.status as SessionPlayerStatus, queueEnteredAt: player.queueEnteredAt ? new Date(player.queueEnteredAt) : null, lastMatchEndedAt: player.lastMatchEndedAt ? new Date(player.lastMatchEndedAt) : null, checkedInAt: player.checkedInAt ? new Date(player.checkedInAt) : null, checkedOutAt: player.checkedOutAt ? new Date(player.checkedOutAt) : null, restStartedAt: player.restStartedAt ? new Date(player.restStartedAt) : null, currentMatchId: player.currentMatchId ?? null, matchesPlayed: player.matchesPlayed, wins: player.wins, losses: player.losses, pointsFor: player.pointsFor, pointsAgainst: player.pointsAgainst, amountDueMinor: player.amountDueMinor ?? 0, manualPriority: player.manualPriority ?? 0, priorityReason: player.priorityReason ?? null, version: player.version } });
  for (const court of snapshot.courts) await tx.sessionCourt.create({ data: { id: court.id, sessionId: court.sessionId, name: court.name, normalizedName: court.normalizedName, displayOrder: court.displayOrder, status: court.status as CourtStatus, currentMatchId: court.currentMatchId ?? null, closedAt: court.closedAt ? new Date(court.closedAt) : null, version: court.version } });
  for (const fee of snapshot.feeConfigs) await tx.sessionFeeConfig.create({ data: { id: fee.id, sessionId: fee.sessionId, mode: fee.mode as FeeMode, currencyCode: fee.currencyCode, fixedAmountPerPlayerMinor: fee.fixedAmountPerPlayerMinor ?? null, expectedSessionCostMinor: fee.expectedSessionCostMinor ?? null, participationRule: fee.participationRule, frozenAt: fee.frozenAt ? new Date(fee.frozenAt) : null, version: fee.version } });
  for (const payment of snapshot.payments) await tx.payment.create({ data: { id: payment.id, sessionId: payment.sessionId, sessionPlayerId: payment.sessionPlayerId, kind: payment.kind as PaymentKind, method: payment.method as PaymentMethod | null, amountMinor: payment.amountMinor, reference: payment.reference, note: payment.note, reversalOfPaymentId: payment.reversalOfPaymentId, recordedById: queueMasterId, occurredAt: new Date(payment.occurredAt), createdAt: new Date(payment.createdAt) } });
  for (const match of snapshot.matches) { await tx.match.create({ data: { id: match.id, sessionId: match.sessionId, courtId: match.courtId ?? null, status: match.status as MatchStatus, source: match.source as MatchSource, matchmakingMode: match.matchmakingMode as MatchmakingMode | null, algorithmVersion: match.algorithmVersion, suggestionKey: match.suggestionKey, suggestionExplanation: match.suggestionExplanation as Prisma.InputJsonValue | undefined, queuedAt: new Date(match.queuedAt), startedAt: match.startedAt ? new Date(match.startedAt) : null, completedAt: match.completedAt ? new Date(match.completedAt) : null, cancelledAt: match.cancelledAt ? new Date(match.cancelledAt) : null, cancellationReason: match.cancellationReason, winnerTeam: match.winnerTeam as TeamSide | null, currentRevisionId: match.currentRevisionId ?? null, version: match.version } }); for (const participant of match.participants) await tx.matchParticipant.create({ data: { id: participant.id, matchId: match.id, sessionPlayerId: participant.sessionPlayerId, team: participant.team as TeamSide, teamSlot: participant.teamSlot, priorQueueEnteredAt: participant.priorQueueEnteredAt ? new Date(participant.priorQueueEnteredAt) : null } }); for (const revision of match.scoreRevisions) { await tx.matchScoreRevision.create({ data: { id: revision.id, matchId: match.id, revisionNumber: revision.revisionNumber, winnerTeam: revision.winnerTeam as TeamSide, reason: revision.reason, createdByQueueMasterId: queueMasterId, supersedesRevisionId: revision.supersedesRevisionId ?? null, createdAt: revision.createdAt ? new Date(revision.createdAt) : new Date() } }); for (const game of revision.games) await tx.matchGame.create({ data: { id: game.id, scoreRevisionId: revision.id, gameNumber: game.gameNumber, teamAScore: game.teamAScore, teamBScore: game.teamBScore, winnerTeam: game.winnerTeam as TeamSide, createdAt: revision.createdAt ? new Date(revision.createdAt) : new Date() } }); } }
}

async function feeSummary(sessionId: string) {
  const [configRecord, players, payments] = await Promise.all([
    prisma.sessionFeeConfig.findUnique({ where: { sessionId } }),
    prisma.sessionPlayer.findMany({ where: { sessionId }, orderBy: { displayNameSnapshot: "asc" } }),
    prisma.payment.findMany({ where: { sessionId }, orderBy: { occurredAt: "asc" } }),
  ]);
  const byPlayer = new Map<string, { collected: number; refunded: number; waived: number }>();
  for (const payment of payments) {
    const balance = byPlayer.get(payment.sessionPlayerId) ?? { collected: 0, refunded: 0, waived: 0 };
    if (payment.kind === PaymentKind.COLLECTION) balance.collected += payment.amountMinor;
    if (payment.kind === PaymentKind.REFUND) balance.refunded += payment.amountMinor;
    if (payment.kind === PaymentKind.WAIVER) balance.waived += payment.amountMinor;
    if (payment.kind === PaymentKind.WAIVER_REVERSAL) balance.waived -= payment.amountMinor;
    byPlayer.set(payment.sessionPlayerId, balance);
  }
  const rows = players.map((player) => {
    const balance = byPlayer.get(player.id) ?? { collected: 0, refunded: 0, waived: 0 };
    const netCollected = balance.collected - balance.refunded;
    const outstanding = Math.max(0, player.amountDueMinor - netCollected - balance.waived);
    const status = balance.waived >= player.amountDueMinor && player.amountDueMinor > 0 ? "WAIVED" : outstanding === 0 && player.amountDueMinor > 0 ? "PAID" : netCollected > 0 ? "PARTIAL" : "UNPAID";
    return { sessionPlayerId: player.id, displayName: player.displayNameSnapshot, dueMinor: player.amountDueMinor, collectedMinor: netCollected, waivedMinor: balance.waived, outstandingMinor: outstanding, status };
  });
  return { config: configRecord, expectedMinor: configRecord?.mode === FeeMode.EQUAL_SPLIT ? configRecord.expectedSessionCostMinor ?? 0 : rows.reduce((sum, row) => sum + row.dueMinor, 0), collectedMinor: rows.reduce((sum, row) => sum + row.collectedMinor, 0), outstandingMinor: rows.reduce((sum, row) => sum + row.outstandingMinor, 0), paymentCount: payments.length, players: rows };
}

export function createApp() {
  const app = express();
  app.set("trust proxy", config.trustProxyHops);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ credentials: true, origin: (origin, callback) => { if (!origin || config.frontendOrigins.includes(origin)) callback(null, true); else callback(null, false); } }));
  app.use(express.json({ limit: "25mb" }));
  app.use(cookieParser());
  app.use((pinoHttp as unknown as (options: unknown) => RequestHandler)({ logger, genReqId: () => randomUUID() }));
  app.use((request, response, next) => { response.locals.requestId = request.id; next(); });
  app.get("/health/live", (_request, response) => response.json({ status: "ok", time: new Date().toISOString() }));
  app.get("/health/ready", route(async (_request, response) => { await prisma.$runCommandRaw({ ping: 1 }); response.json({ status: "ready", time: new Date().toISOString() }); }));

  app.use("/api/v1", rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false }), api);

  api.get("/openapi.json", (_request, response) => response.json({ openapi: "3.1.0", info: { title: "Shuttle Queue API", version: "1.0.0" }, servers: [{ url: "/api/v1" }], paths: { "/auth/login": { post: { summary: "Queue Master login" } }, "/players/deletion-preview": { post: { summary: "Preview permanent player deletion" } }, "/players/delete": { post: { summary: "Permanently delete one or more player profiles" } }, "/sessions": { get: { summary: "List sessions" }, post: { summary: "Create a draft session" } }, "/sessions/{id}": { delete: { summary: "Delete a session and optionally its rostered player profiles" } }, "/sessions/{id}/reset": { post: { summary: "Reset a session to a fresh draft" } }, "/sessions/{id}/queue": { get: { summary: "Read the live queue" } }, "/sessions/{id}/history": { get: { summary: "Completed session history" } }, "/sessions/{id}/players/{spId}/history": { get: { summary: "Player session history and statistics" } }, "/sessions/{id}/suggestions": { post: { summary: "Suggest a fair doubles lineup" } }, "/sessions/{id}/matches": { post: { summary: "Create a match" } }, "/sessions/{id}/matches/start-suggestion": { post: { summary: "Atomically start a suggested match" } }, "/matches/{id}/start": { post: { summary: "Start a queued match on a court" } }, "/matches/{id}/complete": { post: { summary: "Complete a race-to-31 match" } }, "/matches/{id}/cancel": { post: { summary: "Discard a queued or playing match" } }, "/sessions/{id}/fees": { get: { summary: "Session fee allocation and reconciliation" } }, "/sessions/{id}/fees/config": { put: { summary: "Update session fee allocation" } }, "/sessions/{id}/payments": { get: { summary: "List session ledger entries" }, post: { summary: "Record a collection or waiver; Idempotency-Key required" } }, "/sessions/{id}/rankings": { get: { summary: "Session leaderboard" } }, "/rankings/career": { get: { summary: "Career leaderboard" } } } }));

  api.post("/auth/login", requireMutationOrigin, route(async (request, response) => {
    const body = parse(z.object({ username: z.string().min(1).max(80), password: z.string().min(1).max(256) }), request.body);
    const normalizedUsername = normalizeUsername(body.username);
    const throttleKey = `${request.ip}:${normalizedUsername}`;
    if (!await throttleLogin(throttleKey)) throw new AppError(429, "RATE_LIMITED", "Too many login attempts.");
    const account = await prisma.queueMaster.findUnique({ where: { normalizedUsername } });
    const valid = account && account.status === QueueMasterStatus.ACTIVE && await verifyPassword(account.passwordHash, body.password).catch(() => false);
    if (!valid) { await recordLoginFailure(throttleKey); throw new AppError(401, "AUTH_INVALID_CREDENTIALS", "Invalid username or password."); }
    await clearLoginFailures(throttleKey);
    const issued = await issueSession(account.id, request, response);
    await prisma.queueMaster.update({ where: { id: account.id }, data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null } });
    responseData(response, { user: { id: account.id, username: account.username, role: "QUEUE_MASTER" }, expiresAt: issued.expiresAt, csrfToken: issued.csrfToken });
  }));
  api.post("/auth/renew", requireAuth, requireMutationOrigin, route(async (request, response) => { const issued = await rotateSession(request as AuthenticatedRequest, response); responseData(response, issued); }));
  api.post("/auth/logout", requireAuth, requireMutationOrigin, route(async (request, response) => { const auth = getAuth(request); await prisma.authSession.update({ where: { id: auth.sessionId }, data: { revokedAt: new Date(), revokeReason: "logout" } }); clearSessionCookie(response); noContent(response); }));
  api.get("/auth/me", requireAuth, route(async (request, response) => { const auth = getAuth(request); const csrfToken = await currentCsrfToken(request as AuthenticatedRequest, response); responseData(response, { user: { id: auth.queueMaster.id, username: auth.queueMaster.username, role: "QUEUE_MASTER" }, csrfToken }); }));

  api.get("/settings", requireAuth, route(async (request, response) => { const settings = await prisma.queueMasterSettings.findUnique({ where: { queueMasterId: authUser(request).id } }); responseData(response, settings); }));
  api.patch("/settings", requireAuth, requireMutationOrigin, route(async (request, response) => {
    const body = parse(z.object({ pointsToWin: z.number().int().min(1).max(99).optional(), winBy: z.number().int().min(1).max(10).optional(), scoreCap: z.number().int().min(1).max(99).nullable().optional(), bestOf: z.union([z.literal(1), z.literal(3)]).optional(), minimumRestMinutes: z.number().int().min(0).max(60).optional(), defaultFeeMode: z.enum([FeeMode.FIXED_PER_PLAYER, FeeMode.EQUAL_SPLIT]).optional(), defaultFixedFeeMinor: z.number().int().min(0).max(2_000_000_000).nullable().optional() }), request.body);
    const current = await prisma.queueMasterSettings.findUnique({ where: { queueMasterId: authUser(request).id } });
    if (!current) throw notFound("Settings not found.");
    const pointsToWin = body.pointsToWin ?? current.pointsToWin;
    const scoreCap = body.scoreCap === undefined ? current.scoreCap : body.scoreCap;
    if (scoreCap !== null && scoreCap < pointsToWin) throw badRequest("The score cap cannot be lower than points to win.");
    assertVersion(current.version, versionFrom(request));
    const updated = await prisma.queueMasterSettings.update({ where: { id: current.id }, data: { ...body, version: { increment: 1 } } });
    responseData(response, updated);
  }));

  api.get("/players", requireAuth, route(async (request, response) => {
    const query = parse(z.object({ search: z.string().max(80).optional(), status: z.enum(Object.values(PlayerStatus) as [string, ...string[]]).optional(), gender: z.enum(genderValues).optional(), skillLevel: z.enum(skillValues).optional() }), request.query);
    const where: Prisma.PlayerWhereInput = { queueMasterId: authUser(request).id, ...(query.status ? { status: query.status as PlayerStatus } : {}), ...(query.gender ? { gender: query.gender as Gender } : {}), ...(query.skillLevel ? { skillLevel: query.skillLevel as SkillLevel } : {}), ...(query.search ? { normalizedName: { contains: normalizeName(query.search) } } : {}) };
    const players = await prisma.player.findMany({ where, orderBy: { normalizedName: "asc" }, take: 100 });
    responseData(response, players.map(playerView), 200, { count: players.length });
  }));
  api.post("/players/deletion-preview", requireAuth, requireMutationOrigin, route(async (request, response) => {
    const body = parse(z.object({ playerIds: z.array(idSchema).min(1).max(100) }), request.body);
    const unique = [...new Set(body.playerIds)];
    if (unique.length !== body.playerIds.length) throw badRequest("Player IDs must be unique.");
    const preview = await prisma.$transaction((tx) => loadPlayerDeletionPreview(tx, authUser(request).id, unique));
    responseData(response, preview);
  }));
  api.post("/players/delete", requireAuth, requireMutationOrigin, route(async (request, response) => {
    const body = parse(z.object({ playerIds: z.array(idSchema).min(1).max(100) }), request.body);
    const unique = [...new Set(body.playerIds)];
    if (unique.length !== body.playerIds.length) throw badRequest("Player IDs must be unique.");
    const result = await prisma.$transaction((tx) => deletePlayersInTransaction(tx, request, authUser(request).id, unique));
    responseData(response, result);
  }));
  api.post("/players", requireAuth, requireMutationOrigin, route(async (request, response) => {
    const body = parse(z.object({ displayName: z.string().min(1).max(80), gender: z.enum(genderValues), skillLevel: z.enum(skillValues) }), request.body);
    const displayName = normalizeText(body.displayName);
    const level = body.skillLevel as SkillLevel;
    const player = await prisma.player.create({ data: { queueMasterId: authUser(request).id, displayName, normalizedName: normalizeName(displayName), gender: body.gender as Gender, skillLevel: level, skillWeight: skillWeight(level) } }).catch((error: unknown) => { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw conflict("PLAYER_NAME_CONFLICT", "A player with that name already exists."); throw error; });
    responseData(response, playerView(player), 201);
  }));
  api.get("/players/:id", requireAuth, route(async (request, response) => { const player = await prisma.player.findFirst({ where: ownerWhere(request, request.params.id) }); if (!player) throw notFound("Player not found."); responseData(response, playerView(player)); }));
  api.patch("/players/:id", requireAuth, requireMutationOrigin, route(async (request, response) => {
    const current = await prisma.player.findFirst({ where: ownerWhere(request, request.params.id) }); if (!current) throw notFound("Player not found."); assertVersion(current.version, versionFrom(request));
    const body = parse(z.object({ displayName: z.string().min(1).max(80).optional(), gender: z.enum(genderValues).optional(), skillLevel: z.enum(skillValues).optional(), status: z.enum([PlayerStatus.ACTIVE, PlayerStatus.INACTIVE]).optional() }), request.body);
    const displayName = body.displayName ? normalizeText(body.displayName) : current.displayName;
    const level = (body.skillLevel as SkillLevel | undefined) ?? current.skillLevel;
    const player = await prisma.player.update({ where: { id: current.id }, data: { displayName, normalizedName: normalizeName(displayName), gender: body.gender as Gender | undefined, skillLevel: level, skillWeight: skillWeight(level), status: body.status, version: { increment: 1 } } }).catch((error: unknown) => { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw conflict("PLAYER_NAME_CONFLICT", "A player with that name already exists."); throw error; });
    responseData(response, playerView(player));
  }));
  api.post("/players/:id/archive", requireAuth, requireMutationOrigin, route(async (request, response) => { const current = await prisma.player.findFirst({ where: ownerWhere(request, request.params.id) }); if (!current) throw notFound("Player not found."); assertVersion(current.version, versionFrom(request)); const player = await prisma.player.update({ where: { id: current.id }, data: { status: PlayerStatus.ARCHIVED, archivedAt: new Date(), version: { increment: 1 } } }); responseData(response, playerView(player)); }));
  api.post("/players/:id/restore", requireAuth, requireMutationOrigin, route(async (request, response) => { const current = await prisma.player.findFirst({ where: ownerWhere(request, request.params.id) }); if (!current) throw notFound("Player not found."); assertVersion(current.version, versionFrom(request)); const player = await prisma.player.update({ where: { id: current.id }, data: { status: PlayerStatus.ACTIVE, archivedAt: null, version: { increment: 1 } } }); responseData(response, playerView(player)); }));

  api.get("/sessions", requireAuth, route(async (request, response) => { const status = typeof request.query.status === "string" && Object.values(SessionStatus).includes(request.query.status as SessionStatus) ? request.query.status as SessionStatus : undefined; const sessions = await prisma.queueSession.findMany({ where: { queueMasterId: authUser(request).id, ...(status ? { status } : {}) }, orderBy: { sessionDate: "desc" }, take: 100, include: { _count: { select: { players: true, courts: true } } } }); responseData(response, sessions.map(sessionSummary)); }));
  api.post("/sessions", requireAuth, requireMutationOrigin, route(async (request, response) => {
    const body = parse(z.object({ name: z.string().min(1).max(100), sessionDate: z.coerce.date().optional(), pointsToWin: z.number().int().min(1).max(99).optional(), winBy: z.number().int().min(1).max(10).optional(), scoreCap: z.number().int().min(1).max(99).nullable().optional(), bestOf: z.union([z.literal(1), z.literal(3)]).optional(), minimumRestMinutes: z.number().int().min(0).max(60).optional() }), request.body);
    const settings = await prisma.queueMasterSettings.findUnique({ where: { queueMasterId: authUser(request).id } });
    const pointsToWin = body.pointsToWin ?? settings?.pointsToWin ?? 31; const winBy = body.winBy ?? settings?.winBy ?? 1; const scoreCap = body.scoreCap === undefined ? settings?.scoreCap ?? pointsToWin : body.scoreCap; const bestOf = body.bestOf ?? settings?.bestOf ?? 1;
    if (scoreCap !== null && scoreCap < pointsToWin) throw badRequest("The score cap cannot be lower than points to win.");
    const session = await prisma.queueSession.create({ data: { queueMasterId: authUser(request).id, name: normalizeText(body.name), normalizedName: normalizeName(body.name), sessionDate: body.sessionDate ?? new Date(), pointsToWin, winBy, scoreCap, bestOf, minimumRestMinutes: body.minimumRestMinutes ?? settings?.minimumRestMinutes ?? 0, feeConfig: { create: { mode: settings?.defaultFeeMode ?? FeeMode.FIXED_PER_PLAYER, fixedAmountPerPlayerMinor: settings?.defaultFixedFeeMinor ?? null, expectedSessionCostMinor: 0 } } } });
    responseData(response, sessionSummary(session), 201);
  }));
  api.get("/sessions/:id", requireAuth, route(async (request, response) => { const session = await prisma.queueSession.findFirst({ where: ownerWhere(request, request.params.id), include: { _count: { select: { players: true, courts: true } } } }); if (!session) throw notFound("Session not found."); responseData(response, sessionSummary(session)); }));
  api.patch("/sessions/:id", requireAuth, requireMutationOrigin, route(async (request, response) => { const current = await getOwnedSession(request, request.params.id); assertVersion(current.version, versionFrom(request)); if (current.status !== SessionStatus.DRAFT) throw conflict("SESSION_SETTINGS_FROZEN", "Only draft sessions can be edited."); const body = parse(z.object({ name: z.string().min(1).max(100).optional(), sessionDate: z.coerce.date().optional(), pointsToWin: z.number().int().min(1).max(99).optional(), winBy: z.number().int().min(1).max(10).optional(), scoreCap: z.number().int().min(1).max(99).nullable().optional(), bestOf: z.union([z.literal(1), z.literal(3)]).optional(), minimumRestMinutes: z.number().int().min(0).max(60).optional() }), request.body); const scoreCap = body.scoreCap === undefined ? current.scoreCap : body.scoreCap; const points = body.pointsToWin ?? current.pointsToWin; if (scoreCap !== null && scoreCap < points) throw badRequest("The score cap cannot be lower than points to win."); const session = await prisma.queueSession.update({ where: { id: current.id }, data: { ...body, ...(body.name ? { name: normalizeText(body.name), normalizedName: normalizeName(body.name) } : {}), pointsToWin: points, scoreCap, version: { increment: 1 } } }); responseData(response, sessionSummary(session)); }));
  api.post("/sessions/:id/start", requireAuth, requireMutationOrigin, route(async (request, response) => { const session = await getOwnedSession(request, request.params.id); const expectedVersion = versionFrom(request); if (expectedVersion === undefined) throw conflict("VERSION_REQUIRED", "The current session version is required."); assertVersion(session.version, expectedVersion); if (session.status !== SessionStatus.DRAFT) throw conflict("SESSION_NOT_DRAFT", "Only draft sessions can start."); const courts = await prisma.sessionCourt.count({ where: { sessionId: session.id, status: { not: CourtStatus.CLOSED } } }); if (courts === 0) throw conflict("SESSION_NO_COURT", "Add at least one court before starting."); const claimed = await prisma.queueSession.updateMany({ where: { id: session.id, status: SessionStatus.DRAFT, version: expectedVersion }, data: { status: SessionStatus.ACTIVE, startedAt: new Date(), version: { increment: 1 } } }); if (claimed.count !== 1) throw conflict("VERSION_CONFLICT", "The session changed on another device."); const updated = await prisma.queueSession.findUnique({ where: { id: session.id } }); responseData(response, sessionSummary(updated)); }));
  api.post("/sessions/:id/end", requireAuth, requireMutationOrigin, route(async (request, response) => { const session = await getOwnedSession(request, request.params.id); if (session.status !== SessionStatus.ACTIVE) throw conflict("SESSION_NOT_ACTIVE", "Only active sessions can end."); const open = await prisma.match.count({ where: { sessionId: session.id, status: { in: [MatchStatus.QUEUED, MatchStatus.IN_PROGRESS] } } }); if (open > 0) throw conflict("SESSION_OPEN_MATCHES", "Finish or cancel all open matches first."); const claimed = await prisma.queueSession.updateMany({ where: { id: session.id, status: SessionStatus.ACTIVE }, data: { status: SessionStatus.ENDED, endedAt: new Date(), version: { increment: 1 } } }); if (claimed.count !== 1) throw conflict("SESSION_NOT_ACTIVE", "The session changed before it could end."); const updated = await prisma.queueSession.findUnique({ where: { id: session.id } }); responseData(response, sessionSummary(updated)); }));
  api.post("/sessions/:id/cancel", requireAuth, requireMutationOrigin, route(async (request, response) => { const session = await getOwnedSession(request, request.params.id); if (session.status !== SessionStatus.DRAFT) throw conflict("SESSION_NOT_CANCELLABLE", "Only draft sessions can be cancelled."); const claimed = await prisma.queueSession.updateMany({ where: { id: session.id, status: SessionStatus.DRAFT }, data: { status: SessionStatus.CANCELLED, cancelledAt: new Date(), version: { increment: 1 } } }); if (claimed.count !== 1) throw conflict("SESSION_NOT_CANCELLABLE", "The session changed before it could be cancelled."); const updated = await prisma.queueSession.findUnique({ where: { id: session.id } }); responseData(response, sessionSummary(updated)); }));

  api.post("/sessions/:id/reset", requireAuth, requireMutationOrigin, route(async (request, response) => {
    const session = await getOwnedSession(request, request.params.id);
    const expectedVersion = versionFrom(request);
    if (expectedVersion === undefined) throw conflict("VERSION_REQUIRED", "The current session version is required.");
    assertVersion(session.version, expectedVersion);
    const queueMasterId = authUser(request).id;
    await prisma.$transaction(async (tx) => {
      await clearSessionHistory(tx, session.id, queueMasterId);
      await tx.sessionPlayer.updateMany({ where: { sessionId: session.id }, data: { status: SessionPlayerStatus.INACTIVE, checkedInAt: null, checkedOutAt: null, restStartedAt: null, queueEnteredAt: null, lastMatchEndedAt: null, manualPriority: 0, priorityReason: null, currentMatchId: null, matchesPlayed: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, amountDueMinor: 0, version: { increment: 1 } } });
      await tx.sessionCourt.updateMany({ where: { sessionId: session.id }, data: { currentMatchId: null, version: { increment: 1 } } });
      await tx.sessionCourt.updateMany({ where: { sessionId: session.id, status: { not: CourtStatus.CLOSED } }, data: { status: CourtStatus.AVAILABLE, closedAt: null, version: { increment: 1 } } });
      await tx.sessionFeeConfig.updateMany({ where: { sessionId: session.id }, data: { frozenAt: null, version: { increment: 1 } } });
      await tx.queueSession.update({ where: { id: session.id }, data: { status: SessionStatus.DRAFT, startedAt: null, endedAt: null, cancelledAt: null, matchmakingRevision: { increment: 1 }, version: { increment: 1 } } });
      await audit(tx, request, { sessionId: session.id, action: "SESSION_RESET", entityType: "SESSION", entityId: session.id, reason: "Reset from Settings" });
      await rebuildCareerStats(tx, queueMasterId);
    });
    const updated = await prisma.queueSession.findFirst({ where: { id: session.id }, include: { _count: { select: { players: true, courts: true } } } });
    responseData(response, sessionSummary(updated));
  }));

  api.delete("/sessions/:id", requireAuth, requireMutationOrigin, route(async (request, response) => {
    const session = await getOwnedSession(request, request.params.id);
    const expectedVersion = versionFrom(request);
    if (expectedVersion === undefined) throw conflict("VERSION_REQUIRED", "The current session version is required.");
    assertVersion(session.version, expectedVersion);
    const queueMasterId = authUser(request).id;
    const body = parse(z.object({ playerDisposition: z.enum(["KEEP", "DELETE_ALL"]).default("KEEP") }), request.body ?? {});
    await prisma.$transaction(async (tx) => {
      const rosterPlayerIds = body.playerDisposition === "DELETE_ALL"
        ? (await tx.sessionPlayer.findMany({ where: { sessionId: session.id }, select: { playerId: true } })).map((player) => player.playerId)
        : [];
      if (body.playerDisposition === "DELETE_ALL" && rosterPlayerIds.length) await deletePlayersInTransaction(tx, request, queueMasterId, rosterPlayerIds);
      await clearSessionHistory(tx, session.id, queueMasterId);
      await tx.auditLog.deleteMany({ where: { sessionId: session.id } });
      await tx.sessionFeeConfig.deleteMany({ where: { sessionId: session.id } });
      await tx.sessionPlayer.deleteMany({ where: { sessionId: session.id } });
      await tx.sessionCourt.deleteMany({ where: { sessionId: session.id } });
      await tx.queueSession.delete({ where: { id: session.id } });
      await rebuildCareerStats(tx, queueMasterId);
      await audit(tx, request, { entityType: "ACCOUNT", entityId: queueMasterId, action: "SESSION_DELETED", reason: body.playerDisposition === "DELETE_ALL" ? "Session deleted with rostered player profiles" : "Session deleted while keeping player profiles", before: { sessionId: session.id, sessionName: session.name, playerDisposition: body.playerDisposition }, after: { sessionRemoved: true, rosteredPlayersRemoved: body.playerDisposition === "DELETE_ALL" } });
    });
    noContent(response);
  }));

  api.get("/sessions/:id/players", requireAuth, route(async (request, response) => { const session = await getOwnedSession(request, request.params.id); const players = await prisma.sessionPlayer.findMany({ where: { sessionId: session.id }, orderBy: [{ status: "asc" }, { queueEnteredAt: "asc" }] }); responseData(response, players.map(sessionPlayerView)); }));
  api.post("/sessions/:id/players", requireAuth, requireMutationOrigin, route(async (request, response) => { const session = await getOwnedSession(request, request.params.id); if (session.status === SessionStatus.ENDED || session.status === SessionStatus.CANCELLED) throw conflict("SESSION_NOT_ACTIVE", "The session cannot accept players."); const body = parse(z.object({ playerIds: z.array(idSchema).min(1).max(100) }), request.body); const unique = [...new Set(body.playerIds)]; const roster = await prisma.player.findMany({ where: { id: { in: unique }, queueMasterId: authUser(request).id, status: PlayerStatus.ACTIVE } }); if (roster.length !== unique.length) throw conflict("PLAYER_INELIGIBLE", "Every selected player must be active and owned by you."); const existing = await prisma.sessionPlayer.findMany({ where: { sessionId: session.id, playerId: { in: unique } } }); if (existing.length) throw conflict("PLAYER_ALREADY_IN_SESSION", "One or more players are already in this session."); const created = await prisma.$transaction(async (tx) => Promise.all(roster.map((player) => tx.sessionPlayer.create({ data: { sessionId: session.id, playerId: player.id, displayNameSnapshot: player.displayName, normalizedNameSnapshot: player.normalizedName, genderSnapshot: player.gender, skillLevelSnapshot: player.skillLevel, skillWeightSnapshot: player.skillWeight, currentMatchId: null } })))); responseData(response, created.map(sessionPlayerView), 201); }));
  api.post("/sessions/:id/players/:spId/check-in", requireAuth, requireMutationOrigin, route(async (request, response) => { const session = await getOwnedSession(request, request.params.id); if (!([SessionStatus.DRAFT, SessionStatus.ACTIVE] as SessionStatus[]).includes(session.status)) throw conflict("SESSION_NOT_ACTIVE", "The session cannot accept check-ins."); const player = await prisma.sessionPlayer.findFirst({ where: { id: request.params.spId, sessionId: session.id } }); if (!player) throw notFound("Session player not found."); const updatedCount = await prisma.sessionPlayer.updateMany({ where: { id: player.id, sessionId: session.id, status: { in: [SessionPlayerStatus.INACTIVE, SessionPlayerStatus.CHECKED_OUT] } }, data: { status: SessionPlayerStatus.WAITING, checkedInAt: player.checkedInAt ?? new Date(), checkedOutAt: null, queueEnteredAt: new Date(), version: { increment: 1 } } }); if (updatedCount.count !== 1) throw conflict("INVALID_PLAYER_TRANSITION", "The player cannot be checked in from the current state."); const updated = await prisma.sessionPlayer.findUnique({ where: { id: player.id } }); responseData(response, sessionPlayerView(updated)); }));
  api.post("/sessions/:id/players/:spId/rest", requireAuth, requireMutationOrigin, route(async (request, response) => { const session = await getOwnedSession(request, request.params.id); const updatedCount = await prisma.sessionPlayer.updateMany({ where: { id: request.params.spId, sessionId: session.id, status: SessionPlayerStatus.WAITING }, data: { status: SessionPlayerStatus.RESTING, restStartedAt: new Date(), version: { increment: 1 } } }); if (updatedCount.count !== 1) throw conflict("INVALID_PLAYER_TRANSITION", "Only waiting players can rest."); const updated = await prisma.sessionPlayer.findUnique({ where: { id: request.params.spId } }); responseData(response, sessionPlayerView(updated)); }));
  api.post("/sessions/:id/players/:spId/resume", requireAuth, requireMutationOrigin, route(async (request, response) => { const session = await getOwnedSession(request, request.params.id); const updatedCount = await prisma.sessionPlayer.updateMany({ where: { id: request.params.spId, sessionId: session.id, status: SessionPlayerStatus.RESTING }, data: { status: SessionPlayerStatus.WAITING, restStartedAt: null, queueEnteredAt: new Date(), version: { increment: 1 } } }); if (updatedCount.count !== 1) throw conflict("INVALID_PLAYER_TRANSITION", "Only resting players can resume."); const updated = await prisma.sessionPlayer.findUnique({ where: { id: request.params.spId } }); responseData(response, sessionPlayerView(updated)); }));
  api.post("/sessions/:id/players/:spId/check-out", requireAuth, requireMutationOrigin, route(async (request, response) => { const session = await getOwnedSession(request, request.params.id); const updatedCount = await prisma.sessionPlayer.updateMany({ where: { id: request.params.spId, sessionId: session.id, status: { in: [SessionPlayerStatus.INACTIVE, SessionPlayerStatus.WAITING, SessionPlayerStatus.RESTING] } }, data: { status: SessionPlayerStatus.CHECKED_OUT, checkedOutAt: new Date(), queueEnteredAt: null, version: { increment: 1 } } }); if (updatedCount.count !== 1) throw conflict("PLAYER_BUSY", "Busy players cannot be checked out."); const updated = await prisma.sessionPlayer.findUnique({ where: { id: request.params.spId } }); responseData(response, sessionPlayerView(updated)); }));
  api.patch("/sessions/:id/players/:spId/priority", requireAuth, requireMutationOrigin, route(async (request, response) => { const session = await getOwnedSession(request, request.params.id); const body = parse(z.object({ manualPriority: z.number().int().min(-1).max(1), reason: z.string().min(3).max(200) }), request.body); const updatedCount = await prisma.sessionPlayer.updateMany({ where: { id: request.params.spId, sessionId: session.id, status: SessionPlayerStatus.WAITING }, data: { manualPriority: body.manualPriority, priorityReason: body.reason, version: { increment: 1 } } }); if (updatedCount.count !== 1) throw conflict("PLAYER_BUSY", "Priority can only be changed for waiting players."); const updated = await prisma.sessionPlayer.findUnique({ where: { id: request.params.spId } }); responseData(response, sessionPlayerView(updated)); }));
  api.get("/sessions/:id/queue", requireAuth, route(async (request, response) => { const session = await getOwnedSession(request, request.params.id); const players = await prisma.sessionPlayer.findMany({ where: { sessionId: session.id }, orderBy: [{ status: "asc" }, { queueEnteredAt: "asc" }] }); responseData(response, { serverTime: new Date(), inactive: players.filter((p) => p.status === SessionPlayerStatus.INACTIVE || p.status === SessionPlayerStatus.CHECKED_OUT).map(sessionPlayerView), waiting: players.filter((p) => p.status === SessionPlayerStatus.WAITING).map(sessionPlayerView), queued: players.filter((p) => p.status === SessionPlayerStatus.QUEUED).map(sessionPlayerView), playing: players.filter((p) => p.status === SessionPlayerStatus.PLAYING).map(sessionPlayerView), resting: players.filter((p) => p.status === SessionPlayerStatus.RESTING).map(sessionPlayerView) }); }));

  api.get("/sessions/:id/courts", requireAuth, route(async (request, response) => { const session = await getOwnedSession(request, request.params.id); const courts = await prisma.sessionCourt.findMany({ where: { sessionId: session.id }, orderBy: { displayOrder: "asc" } }); responseData(response, courts); }));
  api.post("/sessions/:id/courts", requireAuth, requireMutationOrigin, route(async (request, response) => { const session = await getOwnedSession(request, request.params.id); const body = parse(z.object({ name: z.string().min(1).max(60) }), request.body); const count = await prisma.sessionCourt.count({ where: { sessionId: session.id } }); const court = await prisma.sessionCourt.create({ data: { sessionId: session.id, name: normalizeText(body.name), normalizedName: normalizeName(body.name), displayOrder: count, currentMatchId: null } }); responseData(response, court, 201); }));
   api.patch("/sessions/:id/courts/:courtId", requireAuth, requireMutationOrigin, route(async (request, response) => { const session = await getOwnedSession(request, request.params.id); const current = await prisma.sessionCourt.findFirst({ where: { id: request.params.courtId, sessionId: session.id } }); if (!current) throw notFound("Court not found."); assertVersion(current.version, versionFrom(request)); const body = parse(z.object({ name: z.string().min(1).max(60).optional(), status: z.enum(Object.values(CourtStatus) as [string, ...string[]]).optional() }), request.body); if (current.status === CourtStatus.OCCUPIED && body.status && body.status !== CourtStatus.OCCUPIED) throw conflict("COURT_OCCUPIED", "Occupied courts cannot be changed."); const updated = await prisma.sessionCourt.update({ where: { id: current.id }, data: { ...(body.name ? { name: normalizeText(body.name), normalizedName: normalizeName(body.name) } : {}), ...(body.status ? { status: body.status as CourtStatus, closedAt: body.status === CourtStatus.CLOSED ? new Date() : null } : {}), version: { increment: 1 } } }); responseData(response, updated); }));

  api.post("/sessions/:id/suggestions", requireAuth, route(async (request, response) => {
    const session = await getOwnedSession(request, request.params.id); if (session.status !== SessionStatus.ACTIVE) throw conflict("SESSION_NOT_ACTIVE", "Suggestions require an active session."); const body = parse(z.object({ mode: z.enum(modeValues), excludeKeys: z.array(z.string()).max(50).default([]) }), request.body); const players = await prisma.sessionPlayer.findMany({ where: { sessionId: session.id } }); const history = await buildHistory(session.id); const input: MatchPlayer[] = players.map((player) => ({ id: player.id, displayName: player.displayNameSnapshot, gender: player.genderSnapshot, skillWeight: player.skillWeightSnapshot, skillLevel: player.skillLevelSnapshot, status: player.status, gamesPlayed: player.matchesPlayed, queueEnteredAt: player.queueEnteredAt, lastMatchEndedAt: player.lastMatchEndedAt, manualPriority: player.manualPriority })); let suggestion = suggestMatch(input, body.mode as MatchmakingMode, history, body.excludeKeys); let cycleRestarted = false; if (!suggestion && body.excludeKeys.length > 0) { suggestion = suggestMatch(input, body.mode as MatchmakingMode, history); cycleRestarted = Boolean(suggestion); } if (!suggestion) { responseData(response, { suggestion: null, cycleRestarted: false, noMatch: { code: "NO_VALID_GROUP", message: "No eligible group satisfies this mode." } }); return; } const explanation = { ...suggestion.explanation, algorithmVersion: MATCHMAKING_ALGORITHM, cycleRestarted }; const expiresAt = Date.now() + 300_000; const token = signSuggestion({ sessionId: session.id, revision: session.matchmakingRevision, mode: body.mode, key: suggestion.key, teamA: suggestion.teamA.map((p) => p.id), teamB: suggestion.teamB.map((p) => p.id), explanation, expiresAt }); responseData(response, { cycleRestarted, suggestion: { token, expiresAt, ...suggestion, explanation, teamA: suggestion.teamA.map((p) => ({ id: p.id, displayName: p.displayName, gender: p.gender, skillLevel: p.skillLevel, gamesPlayed: p.gamesPlayed })), teamB: suggestion.teamB.map((p) => ({ id: p.id, displayName: p.displayName, gender: p.gender, skillLevel: p.skillLevel, gamesPlayed: p.gamesPlayed })) } });
  }));

   api.post("/sessions/:id/matches", requireAuth, requireMutationOrigin, route(async (request, response) => {
     const session = await getOwnedSession(request, request.params.id); if (session.status !== SessionStatus.ACTIVE) throw conflict("SESSION_NOT_ACTIVE", "Matches require an active session.");
     const body = parse(z.object({ teamA: z.array(idSchema).min(1).max(2), teamB: z.array(idSchema).min(1).max(2), courtId: idSchema.optional(), suggestionToken: z.string().optional() }), request.body);
     if (body.teamA.length !== body.teamB.length) throw badRequest("Singles and doubles require equal team sizes.");
     if (![1, 2].includes(body.teamA.length)) throw badRequest("A matchup must be singles or doubles.");
     const allIds = [...body.teamA, ...body.teamB]; if (new Set(allIds).size !== allIds.length) throw badRequest("A player cannot appear on both teams.");
     let source: MatchSource = MatchSource.MANUAL; let explanation: unknown = undefined; let mode: MatchmakingMode | undefined; let suggestionKey: string | undefined;
     if (body.suggestionToken) {
       if (body.teamA.length !== 2 || body.teamB.length !== 2) throw badRequest("Suggested matches must be doubles.");
       const payload = verifySuggestion(body.suggestionToken); if (payload.sessionId !== session.id || payload.revision !== session.matchmakingRevision || Number(payload.expiresAt) < Date.now()) throw conflict("SUGGESTION_STALE", "Generate a new suggestion."); source = JSON.stringify(payload.teamA) === JSON.stringify(body.teamA) && JSON.stringify(payload.teamB) === JSON.stringify(body.teamB) ? MatchSource.AUTOMATIC : MatchSource.MANUAL_ADJUSTED; explanation = payload.explanation; mode = payload.mode as MatchmakingMode; suggestionKey = payload.key as string;
     }
     const participants = await prisma.sessionPlayer.findMany({ where: { id: { in: allIds }, sessionId: session.id } }); if (participants.length !== allIds.length) throw conflict("PLAYER_INELIGIBLE", "All players must belong to the session.");
     const startsImmediately = Boolean(body.courtId); const targetStatus = startsImmediately ? MatchStatus.IN_PROGRESS : MatchStatus.QUEUED; const playerStatus = startsImmediately ? SessionPlayerStatus.PLAYING : SessionPlayerStatus.QUEUED;
     const match = await prisma.$transaction(async (tx) => {
       const created = await tx.match.create({ data: { sessionId: session.id, courtId: body.courtId, status: targetStatus, source, matchmakingMode: mode, suggestionKey, algorithmVersion: body.suggestionToken ? MATCHMAKING_ALGORITHM : undefined, suggestionExplanation: explanation as Prisma.InputJsonValue | undefined, ...(startsImmediately ? { startedAt: new Date() } : {}), participants: { create: allIds.map((id) => ({ sessionPlayerId: id, priorQueueEnteredAt: participants.find((player) => player.id === id)?.queueEnteredAt ?? null, team: body.teamA.includes(id) ? TeamSide.A : TeamSide.B, teamSlot: body.teamA.includes(id) ? body.teamA.indexOf(id) + 1 : body.teamB.indexOf(id) + 1 })) } } });
       const claimedPlayers = await tx.sessionPlayer.updateMany({ where: { id: { in: allIds }, sessionId: session.id, status: SessionPlayerStatus.WAITING, OR: [{ currentMatchId: null }, { currentMatchId: { isSet: false } }] }, data: { status: playerStatus, currentMatchId: created.id, manualPriority: 0, priorityReason: null, version: { increment: 1 } } });
       if (claimedPlayers.count !== allIds.length) throw conflict("PLAYER_BUSY", "One or more selected players are no longer waiting.");
       if (body.courtId) {
         const claimedCourt = await tx.sessionCourt.updateMany({ where: { id: body.courtId, sessionId: session.id, status: CourtStatus.AVAILABLE, OR: [{ currentMatchId: null }, { currentMatchId: { isSet: false } }] }, data: { status: CourtStatus.OCCUPIED, currentMatchId: created.id, version: { increment: 1 } } });
         if (claimedCourt.count !== 1) throw conflict("COURT_NOT_AVAILABLE", "The selected court is no longer available.");
       }
       await tx.queueSession.update({ where: { id: session.id }, data: { matchmakingRevision: { increment: 1 }, version: { increment: 1 } } }); return created;
     });
     const detail = await prisma.match.findUnique({ where: { id: match.id }, include: { participants: { include: { sessionPlayer: true } } } }); responseData(response, matchView(detail), 201);
   }));
  api.get("/sessions/:id/history", requireAuth, route(async (request, response) => {
    const session = await getOwnedSession(request, request.params.id); const query = historyQuery(request); const normalizedSearch = normalizeName(query.search);
    const where: Prisma.MatchWhereInput = { sessionId: session.id, status: MatchStatus.COMPLETED, ...(normalizedSearch ? { participants: { some: { sessionPlayer: { normalizedNameSnapshot: { contains: normalizedSearch } } } } } : {}) };
    const [total, matches] = await Promise.all([
      prisma.match.count({ where }),
      prisma.match.findMany({ where, orderBy: [{ completedAt: "desc" }, { id: "desc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: { court: true, participants: { include: { sessionPlayer: true } }, scoreRevisions: { include: { games: true }, orderBy: { revisionNumber: "desc" } } } }),
    ]);
    responseData(response, { items: matches.map(historyMatchView), pagination: historyPagination(query.page, query.pageSize, total) });
  }));
  api.get("/sessions/:id/players/:spId/history", requireAuth, route(async (request, response) => {
    const session = await getOwnedSession(request, request.params.id); const query = historyQuery(request); const player = await prisma.sessionPlayer.findFirst({ where: { id: request.params.spId, sessionId: session.id } }); if (!player) throw notFound("Session player not found.");
    const matches = await prisma.match.findMany({ where: { sessionId: session.id, status: MatchStatus.COMPLETED, participants: { some: { sessionPlayerId: player.id } } }, orderBy: [{ completedAt: "desc" }, { id: "desc" }], include: { court: true, participants: { include: { sessionPlayer: true } }, scoreRevisions: { include: { games: true }, orderBy: { revisionNumber: "desc" } } } });
    const partnerCounts = new Map<string, { count: number; displayName: string; sessionPlayerId: string }>(); const opponentCounts = new Map<string, { count: number; displayName: string; sessionPlayerId: string }>(); const durations = matches.map(historyDurationSeconds).filter((value): value is number => value !== null); const addCount = (counts: Map<string, { count: number; displayName: string; sessionPlayerId: string }>, participant: any) => { if (!participant.sessionPlayer) return; const current = counts.get(participant.sessionPlayerId); counts.set(participant.sessionPlayerId, { count: (current?.count ?? 0) + 1, displayName: participant.sessionPlayer.displayNameSnapshot, sessionPlayerId: participant.sessionPlayerId }); };
    for (const match of matches) { const own = match.participants.find((participant: any) => participant.sessionPlayerId === player.id); if (!own) continue; for (const participant of match.participants) { if (participant.sessionPlayerId === player.id) continue; addCount(own.team === participant.team ? partnerCounts : opponentCounts, participant); } }
    const stats = { matchesPlayed: player.matchesPlayed, wins: player.wins, losses: player.losses, winRateBasisPoints: player.matchesPlayed ? Math.floor((player.wins * 10000) / player.matchesPlayed) : 0, pointsFor: player.pointsFor, pointsAgainst: player.pointsAgainst, pointDifferential: player.pointsFor - player.pointsAgainst, averageDurationSeconds: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null, mostPlayedPartner: chooseFrequentParticipant(partnerCounts), mostPlayedOpponent: chooseFrequentParticipant(opponentCounts) };
    responseData(response, { player: { sessionPlayerId: player.id, playerId: player.playerId, displayName: player.displayNameSnapshot, gender: player.genderSnapshot, skillLevel: player.skillLevelSnapshot }, stats, items: matches.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map(historyMatchView), pagination: historyPagination(query.page, query.pageSize, matches.length) });
  }));
  api.get("/sessions/:id/matches", requireAuth, route(async (request, response) => { const session = await getOwnedSession(request, request.params.id); const matches = await prisma.match.findMany({ where: { sessionId: session.id }, orderBy: { queuedAt: "desc" }, take: 100, include: { participants: { include: { sessionPlayer: true } } } }); responseData(response, matches.map(matchView)); }));
  api.get("/matches/:id", requireAuth, route(async (request, response) => { const match = await prisma.match.findFirst({ where: { id: request.params.id, session: { queueMasterId: authUser(request).id } }, include: { participants: { include: { sessionPlayer: true } }, scoreRevisions: { include: { games: true }, orderBy: { revisionNumber: "desc" } } } }); if (!match) throw notFound("Match not found."); responseData(response, { ...matchView(match), scoreRevisions: match.scoreRevisions }); }));
   api.post("/matches/:id/start", requireAuth, requireMutationOrigin, route(async (request, response) => { const body = parse(z.object({ courtId: idSchema }), request.body); const match = await prisma.match.findFirst({ where: { id: request.params.id, session: { queueMasterId: authUser(request).id } }, include: { participants: true } }); if (!match) throw notFound("Match not found."); if (match.status !== MatchStatus.QUEUED) throw conflict("MATCH_NOT_QUEUED", "Only queued matches can start."); const expectedPlayers = match.participants.length; const teamACount = match.participants.filter((participant) => participant.team === TeamSide.A).length; const teamBCount = match.participants.filter((participant) => participant.team === TeamSide.B).length; if (![2, 4].includes(expectedPlayers) || teamACount !== teamBCount || ![1, 2].includes(teamACount)) throw conflict("PLAYER_LOCK_CONFLICT", "The queued lineup is not a valid singles or doubles match."); const started = await prisma.$transaction(async (tx) => { const claimedCourt = await tx.sessionCourt.updateMany({ where: { id: body.courtId, sessionId: match.sessionId, status: CourtStatus.AVAILABLE, OR: [{ currentMatchId: null }, { currentMatchId: { isSet: false } }] }, data: { status: CourtStatus.OCCUPIED, currentMatchId: match.id, version: { increment: 1 } } }); if (claimedCourt.count !== 1) throw conflict("COURT_NOT_AVAILABLE", "The selected court is no longer available."); const claimedPlayers = await tx.sessionPlayer.updateMany({ where: { id: { in: match.participants.map((p) => p.sessionPlayerId) }, currentMatchId: match.id, status: SessionPlayerStatus.QUEUED }, data: { status: SessionPlayerStatus.PLAYING, version: { increment: 1 } } }); if (claimedPlayers.count !== expectedPlayers) throw conflict("PLAYER_LOCK_CONFLICT", "The player lineup changed before start."); return tx.match.update({ where: { id: match.id }, data: { courtId: body.courtId, status: MatchStatus.IN_PROGRESS, startedAt: new Date(), version: { increment: 1 } } }); }); const detail = await prisma.match.findUnique({ where: { id: started.id }, include: { participants: { include: { sessionPlayer: true } } } }); responseData(response, matchView(detail)); }));
  api.post("/matches/:id/cancel", requireAuth, requireMutationOrigin, route(async (request, response) => { parse(z.object({ reason: z.string().min(3).max(200).optional() }).default({}), request.body); const discarded = await discardMatch(request, request.params.id); responseData(response, matchView(discarded)); }));
  api.post("/matches/:id/complete", requireAuth, requireMutationOrigin, route(async (request, response) => { const body = parse(z.object({ games: z.array(z.object({ teamAScore: z.number().int(), teamBScore: z.number().int() })).min(1).max(3) }), request.body); const match = await prisma.match.findFirst({ where: { id: request.params.id, session: { queueMasterId: authUser(request).id } }, include: { participants: true, session: true } }); if (!match) throw notFound("Match not found."); if (match.status !== MatchStatus.IN_PROGRESS) throw conflict("MATCH_NOT_IN_PROGRESS", "Only active matches can be completed."); const validated = validateScores(body.games as ScoreInput[], scoreSettings(match.session)); let aWins = 0; let bWins = 0; for (const game of validated) game.winnerTeam === TeamSide.A ? aWins++ : bWins++; const winnerTeam = aWins > bWins ? TeamSide.A : TeamSide.B; const points = validated.reduce((sum, game) => ({ a: sum.a + game.teamAScore, b: sum.b + game.teamBScore }), { a: 0, b: 0 }); const completed = await prisma.$transaction(async (tx) => { const claimed = await tx.match.updateMany({ where: { id: match.id, status: MatchStatus.IN_PROGRESS }, data: { version: { increment: 1 } } }); if (claimed.count !== 1) throw conflict("MATCH_NOT_IN_PROGRESS", "This match changed before its result could be recorded."); const revision = await tx.matchScoreRevision.create({ data: { matchId: match.id, revisionNumber: 1, winnerTeam, createdByQueueMasterId: authUser(request).id, games: { create: validated.map((game, index) => ({ gameNumber: index + 1, teamAScore: game.teamAScore, teamBScore: game.teamBScore, winnerTeam: game.winnerTeam })) } } }); const updated = await tx.match.update({ where: { id: match.id }, data: { status: MatchStatus.COMPLETED, completedAt: new Date(), winnerTeam, currentRevisionId: revision.id, version: { increment: 1 } } }); if (match.courtId) await tx.sessionCourt.update({ where: { id: match.courtId }, data: { status: CourtStatus.AVAILABLE, currentMatchId: null, version: { increment: 1 } } }); for (const participant of match.participants) { const won = participant.team === winnerTeam; const forPoints = participant.team === TeamSide.A ? points.a : points.b; const againstPoints = participant.team === TeamSide.A ? points.b : points.a; await tx.sessionPlayer.update({ where: { id: participant.sessionPlayerId }, data: { status: SessionPlayerStatus.WAITING, currentMatchId: null, queueEnteredAt: new Date(), lastMatchEndedAt: new Date(), matchesPlayed: { increment: 1 }, wins: { increment: won ? 1 : 0 }, losses: { increment: won ? 0 : 1 }, pointsFor: { increment: forPoints }, pointsAgainst: { increment: againstPoints }, version: { increment: 1 } } }); const player = await tx.sessionPlayer.findUnique({ where: { id: participant.sessionPlayerId } }); if (player) { const career = await tx.playerCareerStat.findUnique({ where: { queueMasterId_playerId: { queueMasterId: authUser(request).id, playerId: player.playerId } } }); const matchesPlayed = (career?.matchesPlayed ?? 0) + 1; const wins = (career?.wins ?? 0) + (won ? 1 : 0); const losses = (career?.losses ?? 0) + (won ? 0 : 1); await tx.playerCareerStat.upsert({ where: { queueMasterId_playerId: { queueMasterId: authUser(request).id, playerId: player.playerId } }, create: { queueMasterId: authUser(request).id, playerId: player.playerId, matchesPlayed, wins, losses, pointDifferential: forPoints - againstPoints, pointsFor: forPoints, pointsAgainst: againstPoints, winRateBasisPoints: Math.floor((wins * 10000) / matchesPlayed), currentStreak: won ? 1 : -1, lastPlayedAt: new Date() }, update: { matchesPlayed: { increment: 1 }, wins: won ? 1 : 0, losses: won ? 0 : 1, pointsFor: { increment: forPoints }, pointsAgainst: { increment: againstPoints }, pointDifferential: { increment: forPoints - againstPoints }, winRateBasisPoints: Math.floor((wins * 10000) / matchesPlayed), currentStreak: won ? { increment: 1 } : { decrement: 1 }, lastPlayedAt: new Date(), version: { increment: 1 } } }); } } return updated; }); const detail = await prisma.match.findUnique({ where: { id: completed.id }, include: { participants: { include: { sessionPlayer: true } }, scoreRevisions: { include: { games: true } } } }); responseData(response, { ...matchView(detail), scoreRevisions: detail?.scoreRevisions }); }));

  api.get("/sessions/:id/rankings", requireAuth, route(async (request, response) => { const session = await getOwnedSession(request, request.params.id); const rows = await prisma.sessionPlayer.findMany({ where: { sessionId: session.id }, orderBy: [{ wins: "desc" }, { matchesPlayed: "desc" }, { normalizedNameSnapshot: "asc" }] }); responseData(response, rows.map((row, index) => ({ rank: index + 1, sessionPlayerId: row.id, player: row.displayNameSnapshot, playerId: row.playerId, gender: row.genderSnapshot, skillLevel: row.skillLevelSnapshot, matchesPlayed: row.matchesPlayed, wins: row.wins, losses: row.losses, winRateBasisPoints: row.matchesPlayed ? Math.floor((row.wins * 10000) / row.matchesPlayed) : 0, pointsFor: row.pointsFor, pointsAgainst: row.pointsAgainst, pointDifferential: row.pointsFor - row.pointsAgainst }))); }));
  api.get("/rankings/career", requireAuth, route(async (request, response) => { const stats = await prisma.playerCareerStat.findMany({ where: { queueMasterId: authUser(request).id }, include: { player: true }, orderBy: [{ wins: "desc" }, { matchesPlayed: "desc" }] }); responseData(response, stats.map((row, index) => ({ rank: index + 1, player: row.player.displayName, playerId: row.playerId, matchesPlayed: row.matchesPlayed, wins: row.wins, losses: row.losses, winRateBasisPoints: row.winRateBasisPoints, pointsFor: row.pointsFor, pointsAgainst: row.pointsAgainst, pointDifferential: row.pointDifferential }))); }));

  api.get("/sessions/:id/fees", requireAuth, route(async (request, response) => { await getOwnedSession(request, request.params.id); responseData(response, await feeSummary(request.params.id)); }));
  api.put("/sessions/:id/fees/config", requireAuth, requireMutationOrigin, route(async (request, response) => {
    const session = await getOwnedSession(request, request.params.id);
    const body = parse(z.object({ mode: z.enum([FeeMode.FIXED_PER_PLAYER, FeeMode.EQUAL_SPLIT]), fixedAmountPerPlayerMinor: z.number().int().min(0).max(2_000_000_000).nullable().optional(), expectedSessionCostMinor: z.number().int().min(0).max(2_000_000_000).nullable().optional() }), request.body);
    if (body.mode === FeeMode.FIXED_PER_PLAYER && body.fixedAmountPerPlayerMinor === undefined) throw badRequest("A fixed amount is required.");
    if (body.mode === FeeMode.EQUAL_SPLIT && body.expectedSessionCostMinor === undefined) throw badRequest("An expected session total is required.");
    const updated = await prisma.$transaction(async (tx) => {
      const configRecord = await tx.sessionFeeConfig.upsert({ where: { sessionId: session.id }, create: { sessionId: session.id, mode: body.mode as FeeMode, fixedAmountPerPlayerMinor: body.fixedAmountPerPlayerMinor ?? null, expectedSessionCostMinor: body.expectedSessionCostMinor ?? 0 }, update: { mode: body.mode as FeeMode, fixedAmountPerPlayerMinor: body.fixedAmountPerPlayerMinor ?? null, expectedSessionCostMinor: body.expectedSessionCostMinor ?? 0, version: { increment: 1 } } });
      const players = await tx.sessionPlayer.findMany({ where: { sessionId: session.id, checkedInAt: { not: null } } });
      const allocations = body.mode === FeeMode.FIXED_PER_PLAYER ? new Map(players.map((player) => [player.id, body.fixedAmountPerPlayerMinor ?? 0])) : allocateEqualSplit(body.expectedSessionCostMinor ?? 0, players.map((player) => player.id));
      await Promise.all(players.map((player) => tx.sessionPlayer.update({ where: { id: player.id }, data: { amountDueMinor: allocations.get(player.id) ?? 0, version: { increment: 1 } } })));
      return configRecord;
    });
    responseData(response, { config: updated, summary: await feeSummary(session.id) });
  }));
  api.get("/sessions/:id/payments", requireAuth, route(async (request, response) => { await getOwnedSession(request, request.params.id); const payments = await prisma.payment.findMany({ where: { sessionId: request.params.id }, orderBy: { occurredAt: "desc" }, take: 200 }); responseData(response, payments); }));
  api.post("/sessions/:id/payments", requireAuth, requireMutationOrigin, route(async (request, response) => {
    const session = await getOwnedSession(request, request.params.id);
    const idempotencyKey = request.get("idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 200) throw badRequest("An Idempotency-Key header is required for payments.");
    const body = parse(z.object({ sessionPlayerId: idSchema, kind: z.enum([PaymentKind.COLLECTION, PaymentKind.WAIVER]), amountMinor: z.number().int().positive().max(2_000_000_000), method: z.enum([PaymentMethod.CASH, PaymentMethod.EWALLET, PaymentMethod.OTHER]).optional(), reference: z.string().max(120).optional(), note: z.string().max(500).optional() }), request.body);
    if (body.kind === PaymentKind.COLLECTION && !body.method) throw badRequest("A payment method is required for a collection.");
    const requestHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.idempotencyRecord.findFirst({ where: { queueMasterId: authUser(request).id, operation: "PAYMENT_CREATE", key: idempotencyKey } });
      if (existing) {
        if (existing.requestHash !== requestHash) throw conflict("IDEMPOTENCY_KEY_REUSED", "The Idempotency-Key was already used for a different payment.");
        const payment = await tx.payment.findUnique({ where: { id: existing.resultId } });
        if (!payment) throw conflict("IDEMPOTENCY_RECORD_INVALID", "The previous payment result is no longer available.");
        return { payment, replayed: true };
      }
      const player = await tx.sessionPlayer.findFirst({ where: { id: body.sessionPlayerId, sessionId: session.id } });
      if (!player) throw notFound("Session player not found.");
      const payment = await tx.payment.create({ data: { sessionId: session.id, sessionPlayerId: player.id, kind: body.kind as PaymentKind, amountMinor: body.amountMinor, method: body.method as PaymentMethod | undefined, reference: body.reference, note: body.note, recordedById: authUser(request).id } });
      await tx.idempotencyRecord.create({ data: { queueMasterId: authUser(request).id, operation: "PAYMENT_CREATE", key: idempotencyKey, requestHash, resultType: "PAYMENT", resultId: payment.id, responseStatus: 201, expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30) } });
      return { payment, replayed: false };
    });
    responseData(response, { payment: result.payment, summary: await feeSummary(session.id), replayed: result.replayed }, result.replayed ? 200 : 201);
  }));

  app.use((request, response, next) => {
    if (request.originalUrl.startsWith("/api/v1")) {
      response.status(404).json({ error: { code: "NOT_FOUND", message: "The requested resource was not found." }, requestId: response.locals.requestId });
      return;
    }
    next();
  });
  app.use(errorHandler);
  return app;
}
