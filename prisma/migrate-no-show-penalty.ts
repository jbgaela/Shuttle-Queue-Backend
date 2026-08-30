import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const missingPenaltyFilter = { $or: [{ noShowPenaltyMinor: { $exists: false } }, { noShowPenaltyMinor: null }] };

async function missingCount(collection: string) {
  const result = await prisma.$runCommandRaw({ aggregate: collection, pipeline: [{ $match: missingPenaltyFilter }, { $count: "count" }], cursor: {} }) as { cursor?: { firstBatch?: Array<{ count?: number }> } };
  return result.cursor?.firstBatch?.[0]?.count ?? 0;
}

async function backfill(collection: string) {
  await prisma.$runCommandRaw({ update: collection, updates: [{ q: missingPenaltyFilter, u: { $set: { noShowPenaltyMinor: 0 } }, multi: true }] });
}

async function main() {
  const [missingSettings, missingFeeConfigs] = await Promise.all([missingCount("QueueMasterSettings"), missingCount("QueueFeeConfig")]);
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", missingSettings, missingFeeConfigs }, null, 2));
  if (!apply) return;
  await Promise.all([backfill("QueueMasterSettings"), backfill("QueueFeeConfig")]);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
