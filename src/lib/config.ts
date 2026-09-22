import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1),
  FRONTEND_ORIGINS: z.string().default("http://localhost:3000"),
  SESSION_SECRET_PEPPER: z.string().min(16),
  SUGGESTION_SIGNING_SECRET: z.string().min(16),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(720),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(168),
  COOKIE_SECURE: z.string().default("false"),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  LOG_LEVEL: z.string().default("info"),
  PUBLIC_RANKING_EDGE_SECRET: z.string().default(""),
  PUBLIC_RANKING_LOCATION_REQUIRED: z.enum(["true", "false"]).default("false"),
  PUBLIC_RANKING_ACCESS_ENABLED: z.enum(["true", "false"]).default("true"),
  ARGON2_MEMORY_KIB: z.coerce.number().int().positive().default(19456),
  ARGON2_TIME_COST: z.coerce.number().int().positive().default(2),
  ARGON2_PARALLELISM: z.coerce.number().int().positive().default(1),
}).superRefine((values, context) => {
  if (values.NODE_ENV !== "production") return;
  if (values.PUBLIC_RANKING_EDGE_SECRET.length < 32) context.addIssue({ code: z.ZodIssueCode.custom, path: ["PUBLIC_RANKING_EDGE_SECRET"], message: "Configure a random edge signing secret of at least 32 characters in production." });
  if (values.COOKIE_SECURE.toLowerCase() !== "true") context.addIssue({ code: z.ZodIssueCode.custom, path: ["COOKIE_SECURE"], message: "COOKIE_SECURE must be true in production." });
  if (values.TRUST_PROXY_HOPS < 1) context.addIssue({ code: z.ZodIssueCode.custom, path: ["TRUST_PROXY_HOPS"], message: "TRUST_PROXY_HOPS must be configured for the production proxy." });
  if (values.SESSION_SECRET_PEPPER === "replace-with-a-long-random-secret" || values.SUGGESTION_SIGNING_SECRET === "replace-with-a-different-long-random-secret") context.addIssue({ code: z.ZodIssueCode.custom, path: ["SESSION_SECRET_PEPPER"], message: "Production signing secrets must not use example values." });
  if (values.DATABASE_URL.includes("cluster.example.mongodb.net") || values.DATABASE_URL.includes("username:password")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["DATABASE_URL"], message: "Production DATABASE_URL must point to a configured database." });
});

const parsed = envSchema.parse(process.env);

export const config = {
  nodeEnv: parsed.NODE_ENV,
  port: parsed.PORT,
  databaseUrl: parsed.DATABASE_URL,
  frontendOrigins: parsed.FRONTEND_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
  sessionSecretPepper: parsed.SESSION_SECRET_PEPPER,
  suggestionSigningSecret: parsed.SUGGESTION_SIGNING_SECRET,
  sessionIdleMinutes: parsed.SESSION_IDLE_MINUTES,
  sessionAbsoluteHours: parsed.SESSION_ABSOLUTE_HOURS,
  cookieSecure: parsed.COOKIE_SECURE.toLowerCase() === "true",
  trustProxyHops: parsed.TRUST_PROXY_HOPS,
  logLevel: parsed.LOG_LEVEL,
  publicRankingEdgeSecret: parsed.PUBLIC_RANKING_EDGE_SECRET,
  publicRankingLocationRequired: parsed.PUBLIC_RANKING_LOCATION_REQUIRED === "true",
  publicRankingAccessEnabled: parsed.PUBLIC_RANKING_ACCESS_ENABLED === "true",
  argon2MemoryKib: parsed.ARGON2_MEMORY_KIB,
  argon2TimeCost: parsed.ARGON2_TIME_COST,
  argon2Parallelism: parsed.ARGON2_PARALLELISM,
} as const;
