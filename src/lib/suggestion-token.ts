import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const modeSchema = z.enum([
  "OPEN",
  "SAME_SKILL",
  "SAME_GENDER",
  "MIXED_DOUBLES",
  "BALANCED",
  "UNDEFEATED_CHALLENGE",
  "GUIDED",
]);
const teamSchema = z.union([
  z.tuple([z.string().min(1)]),
  z.tuple([z.string().min(1), z.string().min(1)]),
]);

export const suggestionTokenPayloadSchema = z.object({
  algorithmVersion: z.string().min(1),
  queueMasterId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  mode: modeSchema,
  strengthGap: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  key: z.string().min(3),
  teamA: teamSchema,
  teamB: teamSchema,
  expiresAt: z.number().int().positive(),
}).strict();

export type SuggestionTokenPayload = z.infer<typeof suggestionTokenPayloadSchema>;

function decodeBase64Url(value: string) {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error("Invalid suggestion token");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("Invalid suggestion token");
  return decoded;
}

function signatureFor(body: string, secret: string) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function signSuggestionToken(payload: Record<string, unknown>, secret: string, algorithmVersion: string) {
  const body = Buffer.from(JSON.stringify({ ...payload, algorithmVersion })).toString("base64url");
  return `${body}.${signatureFor(body, secret)}`;
}

export function parseAndVerifySuggestionToken(value: string, secret: string) {
  const parts = value.split(".");
  if (parts.length !== 2) {
    throw new Error("Invalid suggestion token");
  }
  const [body, signature] = parts as [string, string];
  const expected = Buffer.from(signatureFor(body, secret), "base64url");
  const actual = decodeBase64Url(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("Invalid suggestion token");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(body).toString("utf8"));
  } catch {
    throw new Error("Invalid suggestion token");
  }
  const result = suggestionTokenPayloadSchema.safeParse(parsed);
  if (!result.success) throw new Error("Invalid suggestion token");
  const { teamA, teamB } = result.data;
  if (teamA.length !== teamB.length || new Set([...teamA, ...teamB]).size !== teamA.length + teamB.length) {
    throw new Error("Invalid suggestion token");
  }
  const canonicalKey = `${[...teamA].sort().join(",")}|${[...teamB].sort().join(",")}`;
  if (result.data.key !== canonicalKey) throw new Error("Invalid suggestion token");
  if (result.data.mode !== "BALANCED" && result.data.strengthGap !== undefined) throw new Error("Invalid suggestion token");
  if (result.data.mode === "BALANCED" && result.data.strengthGap === undefined) throw new Error("Invalid suggestion token");
  return result.data;
}
