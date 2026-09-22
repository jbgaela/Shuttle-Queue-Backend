import express, { type Request, type RequestHandler } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { verifyRankingEdge, type RankingVisitor } from "./ranking-tracking.js";

export type RankingRequest = Request & { rankingVisitor?: RankingVisitor };
export const rankingVisitorKey = (request: Request) => ipKeyGenerator((request as RankingRequest).rankingVisitor?.ip ?? request.ip ?? request.socket.remoteAddress ?? "127.0.0.1");
export const publicRankingLimiter = (limit: number) => rateLimit({ windowMs: 60_000, limit, standardHeaders: "draft-8", legacyHeaders: false, keyGenerator: rankingVisitorKey,
  handler: (_request, response) => { response.setHeader("Cache-Control", "no-store"); response.locals.trackingOutcome = "throttled"; response.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests. Please wait and try again." } }); },
});

// This parser runs before the application's larger offline-sync body parser.
export const publicRankingBody = express.raw({ type: () => true, limit: "4kb", inflate: false });
export const publicRankingEdge: RequestHandler = (request: RankingRequest, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  try {
    if (!config.publicRankingAccessEnabled) throw new AppError(503, "PUBLIC_RANKINGS_DISABLED", "Public rankings are temporarily unavailable.");
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    if (config.nodeEnv === "production") {
      request.rankingVisitor = verifyRankingEdge({ metadata: request.get("x-ranking-edge-metadata") ?? "", signature: request.get("x-ranking-edge-signature") ?? "", method: request.method, path: request.originalUrl, body, secret: config.publicRankingEdgeSecret });
    } else {
      request.rankingVisitor = { timestamp: Date.now(), requestId: "local", ip: request.socket.remoteAddress ?? "127.0.0.1", userAgent: (request.get("user-agent") ?? "").slice(0, 1024), city: null, region: null, country: null };
    }
    if (body.length) {
      if (!request.is("application/json")) throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Send JSON for tracking requests.");
      try { request.body = JSON.parse(body.toString("utf8")); } catch { throw new AppError(400, "INVALID_JSON", "Invalid JSON body."); }
    } else request.body = {};
    next();
  } catch (error) { next(error); }
};
