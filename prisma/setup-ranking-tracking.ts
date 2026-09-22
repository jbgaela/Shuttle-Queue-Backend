import { PrismaClient } from "@prisma/client";
import { ensureTrackingLink } from "../src/lib/ranking-tracking.js";

const database = new PrismaClient();
try {
  let cursor: string | undefined;
  let count = 0;
  for (;;) {
    const publications = await database.publicRankingPublication.findMany({ orderBy: { id: "asc" }, take: 100, ...(cursor ? { where: { id: { gt: cursor } } } : {}) });
    if (!publications.length) break;
    for (const publication of publications) { await ensureTrackingLink(database, publication); count += 1; }
    cursor = publications.at(-1)!.id;
  }
  await database.$runCommandRaw({ createIndexes: "PublicRankingVisit", indexes: [{ key: { expiresAt: 1 }, name: "PublicRankingVisit_expiresAt_ttl", expireAfterSeconds: 0 }] });
  console.log(`Ranking tracking ready: ${count} publication tokens backfilled; 90-day TTL index installed.`);
} finally { await database.$disconnect(); }
