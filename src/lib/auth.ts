import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CookieOptions, NextFunction, Request, RequestHandler, Response } from "express";
import argon2 from "argon2";
import type { QueueMaster } from "@prisma/client";
import { prisma } from "./db.js";
import { config } from "./config.js";
import { AppError, forbidden, unauthorized } from "./errors.js";

export type AuthenticatedRequest = Request & {
  auth?: { queueMaster: QueueMaster; sessionId: string; csrfToken: string; csrfTokenHash: string; absoluteExpiresAt: Date; sessionVersion: number };
};

const cookieName = config.cookieSecure ? "__Host-bq-session" : "bq-session";
const csrfCookieName = config.cookieSecure ? "__Host-bq-csrf" : "bq-csrf";
// Production UI and API hosts are cross-site, so secure cookies must remain usable without shared third-party storage.
const sharedCookieOptions: Pick<CookieOptions, "partitioned" | "path" | "sameSite" | "secure"> = {
  partitioned: config.cookieSecure,
  path: "/",
  sameSite: config.cookieSecure ? "none" : "strict",
  secure: config.cookieSecure,
};
const THROTTLE_ENTRY_TTL_MS = 30 * 60_000;
const THROTTLE_CLEANUP_INTERVAL_MS = 60_000;
let lastThrottleCleanupAt = 0;

const digest = (value: string) => createHmac("sha256", config.sessionSecretPepper).update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const parseSessionCookie = (value: string | undefined) => {
  if (!value) return null;
  const separator = value.indexOf(".");
  if (separator <= 0) return null;
  return { id: value.slice(0, separator), secret: value.slice(separator + 1) };
};

const setSessionCookie = (response: Response, value: string, expires: Date, csrfToken: string) => {
  response.cookie(cookieName, value, {
    ...sharedCookieOptions,
    httpOnly: true,
    expires,
  });
  response.cookie(csrfCookieName, csrfToken, {
    ...sharedCookieOptions,
    httpOnly: false,
    expires,
  });
};

const setCsrfCookie = (response: Response, value: string, expires: Date) => response.cookie(csrfCookieName, value, { ...sharedCookieOptions, httpOnly: false, expires });

export const clearSessionCookie = (response: Response) => {
  response.clearCookie(cookieName, { ...sharedCookieOptions, httpOnly: true });
  response.clearCookie(csrfCookieName, { ...sharedCookieOptions, httpOnly: false });
};

export async function issueSession(queueMasterId: string, request: Request, response: Response) {
  const secret = token();
  const csrfToken = token();
  const now = new Date();
  const idleExpiresAt = new Date(now.getTime() + config.sessionIdleMinutes * 60_000);
  const absoluteExpiresAt = new Date(now.getTime() + config.sessionAbsoluteHours * 3_600_000);
  const session = await prisma.authSession.create({
    data: {
      queueMasterId,
      secretHash: digest(secret),
      csrfTokenHash: digest(csrfToken),
      idleExpiresAt,
      absoluteExpiresAt,
      userAgentHash: request.get("user-agent") ? createHash("sha256").update(request.get("user-agent")!).digest("hex") : undefined,
      ipPrefixHash: request.ip ? createHash("sha256").update(request.ip.split(".").slice(0, 3).join(".")).digest("hex") : undefined,
    },
  });
  setSessionCookie(response, `${session.id}.${secret}`, absoluteExpiresAt, csrfToken);
  return { session, csrfToken, expiresAt: idleExpiresAt };
}

export async function rotateSession(request: AuthenticatedRequest, response: Response) {
  const current = request.auth;
  if (!current) throw unauthorized();
  const nextSecret = token();
  const nextCsrf = token();
  const now = new Date();
  const idleExpiresAt = new Date(Math.min(
    now.getTime() + config.sessionIdleMinutes * 60_000,
    current.absoluteExpiresAt.getTime(),
  ));
  const claimed = await prisma.authSession.updateMany({
    where: { id: current.sessionId, version: current.sessionVersion },
    data: { previousHash: digest((request.cookies?.[cookieName] ?? "").split(".").slice(1).join(".")), secretHash: digest(nextSecret), csrfTokenHash: digest(nextCsrf), rotatedAt: now, lastSeenAt: now, idleExpiresAt, version: { increment: 1 } },
  });
  if (claimed.count !== 1) throw unauthorized("Your session has expired.");
  const updated = await prisma.authSession.findUnique({ where: { id: current.sessionId } });
  if (!updated) throw unauthorized("Your session has expired.");
  setSessionCookie(response, `${updated.id}.${nextSecret}`, updated.absoluteExpiresAt, nextCsrf);
  return { csrfToken: nextCsrf, expiresAt: updated.idleExpiresAt };
}

async function resolveAuth(request: AuthenticatedRequest) {
  const parsed = parseSessionCookie(request.cookies?.[cookieName]);
  if (!parsed) throw unauthorized();
  const session = await prisma.authSession.findUnique({ where: { id: parsed.id }, include: { queueMaster: true } });
  if (!session || session.revokedAt || session.queueMaster.status !== "ACTIVE" || session.idleExpiresAt < new Date() || session.absoluteExpiresAt < new Date()) throw unauthorized("Your session has expired.");
  const secretHash = digest(parsed.secret);
  if (!safeEqual(secretHash, session.secretHash)) {
    if (session.previousHash && safeEqual(secretHash, session.previousHash)) {
      await prisma.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date(), revokeReason: "refresh-replay" } });
    }
    throw unauthorized("Your session has expired.");
  }
  const csrfToken = request.get("x-csrf-token") ?? "";
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS" && !safeEqual(digest(csrfToken), session.csrfTokenHash)) throw new AppError(403, "CSRF_INVALID", "The request could not be verified.");
  if (session.lastSeenAt.getTime() < Date.now() - 5 * 60_000) {
    await prisma.authSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
  }
  request.auth = { queueMaster: session.queueMaster, sessionId: session.id, csrfToken, csrfTokenHash: session.csrfTokenHash, absoluteExpiresAt: session.absoluteExpiresAt, sessionVersion: session.version };
  return request.auth;
}

export async function currentCsrfToken(request: AuthenticatedRequest, response: Response) {
  const auth = request.auth;
  if (!auth) throw unauthorized();
  const headerToken = request.get("x-csrf-token") ?? "";
  const cookieToken = request.cookies?.[csrfCookieName] ?? "";
  if (headerToken && safeEqual(digest(headerToken), auth.csrfTokenHash)) {
    auth.csrfToken = headerToken;
    setCsrfCookie(response, headerToken, auth.absoluteExpiresAt);
    return headerToken;
  }
  if (cookieToken && safeEqual(digest(cookieToken), auth.csrfTokenHash)) {
    auth.csrfToken = cookieToken;
    setCsrfCookie(response, cookieToken, auth.absoluteExpiresAt);
    return cookieToken;
  }

  const nextCsrf = token();
  const claimed = await prisma.authSession.updateMany({
    where: { id: auth.sessionId, version: auth.sessionVersion, csrfTokenHash: auth.csrfTokenHash, revokedAt: null },
    data: { csrfTokenHash: digest(nextCsrf) },
  });
  if (claimed.count !== 1) throw unauthorized("Your session has expired.");
  auth.csrfToken = nextCsrf;
  auth.csrfTokenHash = digest(nextCsrf);
  setCsrfCookie(response, nextCsrf, auth.absoluteExpiresAt);
  return nextCsrf;
}

export const requireAuth: RequestHandler = async (request, _response, next: NextFunction) => {
  try {
    await resolveAuth(request as AuthenticatedRequest);
    next();
  } catch (error) {
    next(error);
  }
};

export const requireMutationOrigin: RequestHandler = (request, _response, next) => {
  const origin = request.get("origin");
  if (config.nodeEnv === "production" && (!origin || !config.frontendOrigins.includes(origin))) {
    next(forbidden("The request origin is not allowed."));
    return;
  }
  next();
};

async function cleanupExpiredThrottleEntries(now: number) {
  if (now - lastThrottleCleanupAt < THROTTLE_CLEANUP_INTERVAL_MS) return;
  lastThrottleCleanupAt = now;
  await prisma.loginThrottle.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });
}

const throttleKeyHash = (key: string) => digest(`login:${key}`);

export async function throttleLogin(key: string) {
  const now = Date.now();
  await cleanupExpiredThrottleEntries(now);
  const entry = await prisma.loginThrottle.findUnique({ where: { keyHash: throttleKeyHash(key) } });
  return !entry || entry.expiresAt <= new Date(now) || !entry.blockedUntil || entry.blockedUntil <= new Date(now);
}

export async function recordLoginFailure(key: string) {
  const now = Date.now();
  await cleanupExpiredThrottleEntries(now);
  const keyHash = throttleKeyHash(key);
  const prior = await prisma.loginThrottle.findUnique({ where: { keyHash } });
  const expiresAt = new Date(now + THROTTLE_ENTRY_TTL_MS);
  if (!prior || prior.expiresAt <= new Date(now)) {
    await prisma.loginThrottle.upsert({ where: { keyHash }, create: { keyHash, failureCount: 1, windowStarted: new Date(now), expiresAt }, update: { failureCount: 1, windowStarted: new Date(now), blockedUntil: null, expiresAt } });
    return;
  }
  const failures = prior.failureCount + 1;
  await prisma.loginThrottle.update({ where: { id: prior.id }, data: { failureCount: { increment: 1 }, blockedUntil: failures >= 5 ? new Date(now + Math.min(15 * 60_000, failures * 30_000)) : prior.blockedUntil, expiresAt } });
}

export async function clearLoginFailures(key: string) {
  await prisma.loginThrottle.deleteMany({ where: { keyHash: throttleKeyHash(key) } });
}

export const passwordHash = (password: string) => argon2.hash(password, { type: argon2.argon2id, memoryCost: config.argon2MemoryKib, timeCost: config.argon2TimeCost, parallelism: config.argon2Parallelism });
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password);
export const sessionCookieName = cookieName;
