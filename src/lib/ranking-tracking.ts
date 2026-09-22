import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import Bowser from "bowser";
import { z } from "zod";
import { Prisma, type PublicRankingPublication } from "@prisma/client";
import { AppError, badRequest } from "./errors.js";

export const VISIT_RETENTION_MS = 90 * 24 * 60 * 60_000;
export const LOCATION_ACCESS_MS = 12 * 60 * 60_000;
export const trackingHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const locationStatusSchema = z.enum(["PENDING", "GRANTED", "DENIED", "TIMEOUT", "UNAVAILABLE"]);
export const locationInputSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("GRANTED"), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), accuracy: z.number().nonnegative().finite() }),
  z.strictObject({ status: z.enum(["DENIED", "TIMEOUT", "UNAVAILABLE"]) }),
]);
export const edgeMetadataSchema = z.strictObject({
  timestamp: z.number().int(), requestId: z.string().min(1).max(200),
  ip: z.string().refine((value) => isIP(value) !== 0),
  userAgent: z.string().max(1024),
  city: z.string().max(200).nullable(), region: z.string().max(200).nullable(), country: z.string().max(200).nullable(),
});
export type RankingVisitor = z.infer<typeof edgeMetadataSchema>;

export function verifyRankingEdge(input: { metadata: string; signature: string; method: string; path: string; body: Buffer; secret: string }, now = Date.now()): RankingVisitor {
  const invalid = () => new AppError(403, "INVALID_EDGE_SIGNATURE", "The public ranking request could not be verified.");
  if (!input.secret || input.metadata.length > 8192 || !/^[a-f0-9]{64}$/.test(input.signature)) throw invalid();
  const message = [input.method, input.path, trackingHash(input.body), input.metadata].join("\n");
  const expected = createHmac("sha256", input.secret).update(message).digest();
  if (!timingSafeEqual(expected, Buffer.from(input.signature, "hex"))) throw invalid();
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(input.metadata, "base64url").toString("utf8")); } catch { throw invalid(); }
  const result = edgeMetadataSchema.safeParse(decoded);
  if (!result.success || Math.abs(now - result.data.timestamp) > 60_000) throw invalid();
  return result.data;
}

export function visitKeyHash(value: string | undefined) {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new AppError(403, "LOCATION_REQUIRED", "Share your location to view these rankings.");
  return trackingHash(value);
}

export function reportedDevice(userAgent: string) {
  if (!userAgent.trim()) return { device: "unknown", browser: "Unknown", operatingSystem: "Unknown" };
  const parsed = Bowser.parse(userAgent.slice(0, 1024));
  return {
    device: ["mobile", "tablet", "desktop"].includes(parsed.platform.type ?? "") ? parsed.platform.type! : "unknown",
    browser: [parsed.browser.name, parsed.browser.version].filter(Boolean).join(" ") || "Unknown",
    operatingSystem: [parsed.os.name, parsed.os.version].filter(Boolean).join(" ") || "Unknown",
  };
}

export function hasLocationAccess(visit: { locationStatus: string; accessExpiresAt: Date | null; expiresAt: Date } | null, now = new Date()) {
  return Boolean(visit && visit.locationStatus === "GRANTED" && visit.accessExpiresAt && visit.accessExpiresAt > now && visit.expiresAt > now);
}

export async function ensureTrackingLink(database: Pick<Prisma.TransactionClient, "publicRankingLink">, publication: PublicRankingPublication) {
  const tokenHash = trackingHash(publication.publicToken);
  try {
    return await database.publicRankingLink.upsert({
      where: { tokenHash }, update: {},
      create: { publicationId: publication.id, queueMasterId: publication.queueMasterId, tokenHash, issuedAt: publication.publishedAt, revokedAt: publication.revokedAt },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    return database.publicRankingLink.findUniqueOrThrow({ where: { tokenHash } });
  }
}

const cursorSchema = z.strictObject({ at: z.string().datetime(), id: z.string().uuid() });
export function trackingPage(query: Record<string, unknown>) {
  const result = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(512).optional(), status: locationStatusSchema.optional() }).safeParse(query);
  if (!result.success) throw badRequest("Invalid tracking page or status.");
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (result.data.cursor) {
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(result.data.cursor, "base64url").toString("utf8"))); } catch { throw badRequest("Invalid tracking cursor."); }
  }
  return { ...result.data, cursor };
}
export function trackingCursor(at: Date, id: string) { return Buffer.from(JSON.stringify({ at: at.toISOString(), id })).toString("base64url"); }

export function trackingBefore(field: "issuedAt" | "openedAt", cursor?: { at: string; id: string }) {
  return cursor ? { OR: [{ [field]: { lt: new Date(cursor.at) } }, { [field]: new Date(cursor.at), id: { lt: cursor.id } }] } : {};
}
