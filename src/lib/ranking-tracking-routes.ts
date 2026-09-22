import { Router, type Request, type RequestHandler, type Response } from "express";
import { Prisma, type PrismaClient } from "@prisma/client";
import pino from "pino";
import { prisma } from "./db.js";
import { config } from "./config.js";
import { requireAuth, requireSuperAdmin, type AuthenticatedRequest } from "./auth.js";
import { AppError, badRequest, notFound } from "./errors.js";
import { activePublicRankingWhere } from "./public-rankings.js";
import { ensureTrackingLink, hasLocationAccess, LOCATION_ACCESS_MS, locationInputSchema, reportedDevice, trackingBefore, trackingCursor, trackingHash, trackingPage, visitKeyHash, VISIT_RETENTION_MS } from "./ranking-tracking.js";
import { publicRankingLimiter, type RankingRequest } from "./ranking-tracking-http.js";

type TrackingDatabase = Pick<PrismaClient, "publicRankingPublication" | "publicRankingLink" | "publicRankingVisit">;
const logger = pino({ level: config.logLevel });
const wrap = (handler: (request: Request, response: Response) => Promise<void>): RequestHandler => (request, response, next) => { void handler(request, response).catch(next); };
const send = (response: Response, data: unknown, status = 200) => { response.setHeader("Cache-Control", "private, no-store"); response.status(status).json({ data, requestId: response.locals.requestId }); };
const user = (request: Request) => (request as AuthenticatedRequest).auth!.queueMaster;
const visitSelection = { id: true, openedAt: true, locationReceivedAt: true, accessExpiresAt: true, ipAddress: true, device: true, browser: true, operatingSystem: true, city: true, region: true, country: true, locationStatus: true, latitude: true, longitude: true, accuracy: true } satisfies Prisma.PublicRankingVisitSelect;
const linkSelection = { id: true, issuedAt: true, revokedAt: true, queueMasterId: true, publication: { select: { id: true, sessionStartedAt: true, sessionEndedAt: true, finalizedAt: true } } } satisfies Prisma.PublicRankingLinkSelect;

async function activePublication(database: TrackingDatabase, token: string) {
  if (!/^[0-9a-f-]{36}$/i.test(token)) throw notFound("Public rankings are not available.");
  const publication = await database.publicRankingPublication.findFirst({ where: { publicToken: token, ...activePublicRankingWhere() } });
  if (!publication) throw notFound("Public rankings are not available.");
  return publication;
}

export async function assertRankingLocation(request: Request, publicationId: string, database: TrackingDatabase = prisma) {
  if (!config.publicRankingLocationRequired) return;
  const hash = visitKeyHash(request.get("x-ranking-visit-key"));
  const visit = await database.publicRankingVisit.findFirst({ where: { visitKeyHash: hash, link: { publicationId, tokenHash: trackingHash(String(request.params.token)) } }, select: { locationStatus: true, accessExpiresAt: true, expiresAt: true } });
  if (!hasLocationAccess(visit)) throw new AppError(403, "LOCATION_REQUIRED", "Share your location to view these rankings.");
}

export function createRankingTrackingRouter(database: TrackingDatabase = prisma, auth: RequestHandler = requireAuth, admin: RequestHandler = requireSuperAdmin) {
  const router = Router();
  router.post("/public/rankings/:token/visits", publicRankingLimiter(30), wrap(async (request: RankingRequest, response) => {
    const publication = await activePublication(database, String(request.params.token));
    const hash = visitKeyHash(request.get("x-ranking-visit-key"));
    const visitor = request.rankingVisitor;
    if (!visitor) throw new AppError(403, "INVALID_EDGE_SIGNATURE", "Visitor metadata is unavailable.");
    try {
      const link = await ensureTrackingLink(database, publication);
      let visit;
      try {
        visit = await database.publicRankingVisit.create({ data: { linkId: link.id, visitKeyHash: hash, openedAt: new Date(), expiresAt: new Date(Date.now() + VISIT_RETENTION_MS), ipAddress: visitor.ip, ...reportedDevice(visitor.userAgent), city: visitor.city, region: visitor.region, country: visitor.country } });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
        visit = await database.publicRankingVisit.findUnique({ where: { visitKeyHash: hash } });
        if (!visit || visit.linkId !== link.id || visit.expiresAt <= new Date()) throw new AppError(409, "VISIT_KEY_CONFLICT", "Open the link again to start a new visit.");
      }
      send(response, { visitId: visit.id, status: visit.locationStatus, accessExpiresAt: visit.accessExpiresAt }, 201);
    } catch (error) {
      if (!(error instanceof AppError)) { logger.warn({ event: "ranking_visit_write_failed" }, "Ranking tracking write failed"); throw new AppError(503, "TRACKING_UNAVAILABLE", "Unable to record this visit. Please try again."); }
      throw error;
    }
  }));
  router.patch("/public/rankings/:token/visits/location", publicRankingLimiter(60), wrap(async (request, response) => {
    const publication = await activePublication(database, String(request.params.token));
    const hash = visitKeyHash(request.get("x-ranking-visit-key"));
    const parsed = locationInputSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest("Invalid location result.");
    const now = new Date();
    const where = { visitKeyHash: hash, expiresAt: { gt: now }, link: { publicationId: publication.id, tokenHash: trackingHash(String(request.params.token)) } };
    const visit = await database.publicRankingVisit.findFirst({ where });
    if (!visit) throw notFound("Visit not found. Open the link again.");
    const body = parsed.data;
    try {
      // Atomic eligibility check: a racing denial cannot overwrite an accepted grant.
      await database.publicRankingVisit.updateMany({ where: { ...where, OR: [{ locationStatus: { not: "GRANTED" } }, { accessExpiresAt: { lte: now } }, { accessExpiresAt: null }] }, data: {
        locationStatus: body.status, locationReceivedAt: now,
        ...(body.status === "GRANTED" ? { latitude: body.latitude, longitude: body.longitude, accuracy: body.accuracy, accessExpiresAt: new Date(now.getTime() + LOCATION_ACCESS_MS) } : { latitude: null, longitude: null, accuracy: null, accessExpiresAt: null }),
      } });
      const updated = await database.publicRankingVisit.findUniqueOrThrow({ where: { id: visit.id } });
      send(response, { visitId: updated.id, status: updated.locationStatus, accessExpiresAt: updated.accessExpiresAt });
    } catch { logger.warn({ event: "ranking_location_write_failed" }, "Ranking location write failed"); throw new AppError(503, "TRACKING_UNAVAILABLE", "Unable to save location. Please try again."); }
  }));

  const listLinks = (accountId: (request: Request) => string) => wrap(async (request, response) => {
    const page = trackingPage(request.query);
    const items = await database.publicRankingLink.findMany({ where: { queueMasterId: accountId(request), ...trackingBefore("issuedAt", page.cursor) }, select: linkSelection, orderBy: [{ issuedAt: "desc" }, { id: "desc" }], take: page.limit + 1 });
    const visible = items.slice(0, page.limit);
    const last = visible.at(-1);
    send(response, { items: visible, nextCursor: items.length > page.limit && last ? trackingCursor(last.issuedAt, last.id) : null });
  });
  router.get("/workspace/public-rankings/tracking-links", auth, listLinks((request) => user(request).id));
  router.get("/admin/accounts/:accountId/public-ranking-links", auth, admin, listLinks((request) => String(request.params.accountId)));
  router.get("/workspace/public-rankings/tracking-links/:linkId/visits", auth, wrap(async (request, response) => {
    const owner = user(request);
    const link = await database.publicRankingLink.findFirst({ where: { id: String(request.params.linkId), ...(owner.role === "SUPER_ADMIN" ? {} : { queueMasterId: owner.id }) }, select: linkSelection });
    if (!link) throw notFound("Tracking link not found.");
    const page = trackingPage(request.query);
    const items = await database.publicRankingVisit.findMany({ where: { linkId: link.id, expiresAt: { gt: new Date() }, ...(page.status ? { locationStatus: page.status } : {}), ...trackingBefore("openedAt", page.cursor) }, select: visitSelection, orderBy: [{ openedAt: "desc" }, { id: "desc" }], take: page.limit + 1 });
    const visible = items.slice(0, page.limit);
    const last = visible.at(-1);
    send(response, { link, items: visible, nextCursor: items.length > page.limit && last ? trackingCursor(last.openedAt, last.id) : null });
  }));
  return router;
}
