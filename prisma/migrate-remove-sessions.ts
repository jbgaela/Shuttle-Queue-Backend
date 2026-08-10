import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const backupVerified = process.argv.includes("--backup-verified") || process.env.BACKUP_VERIFIED === "true";

const collections = [
  "QueueSession",
  "SessionPlayer",
  "SessionCourt",
  "SessionFeeConfig",
  "Match",
  "MatchParticipant",
  "MatchScoreRevision",
  "MatchGame",
  "Payment",
  "QueuePlayer",
  "Court",
  "QueueFeeConfig",
  "PlayerCareerStat",
  "IdempotencyRecord",
] as const;

async function countCollection(collection: string) {
  try {
    const result = await prisma.$runCommandRaw({ aggregate: collection, pipeline: [{ $count: "count" }], cursor: {} }) as { cursor?: { firstBatch?: Array<{ count?: number }> } };
    return result.cursor?.firstBatch?.[0]?.count ?? 0;
  } catch {
    return 0;
  }
}

async function deleteCollection(collection: string) {
  await prisma.$runCommandRaw({ delete: collection, deletes: [{ q: {}, limit: 0 }] });
}

async function main() {
  const counts = Object.fromEntries(await Promise.all(collections.map(async (collection) => [collection, await countCollection(collection)] as const)));
  counts.AuditLog = await countCollection("AuditLog");
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", counts }, null, 2));
  if (!apply) return;
  if (!backupVerified) throw new Error("Refusing destructive migration: provide --backup-verified after verifying a MongoDB backup.");

  for (const collection of collections) await deleteCollection(collection);
  // Legacy queue event audits carry sessionId. Account-administration audits do not and remain intact.
  await prisma.$runCommandRaw({ delete: "AuditLog", deletes: [{ q: { sessionId: { $exists: true } }, limit: 0 }] });

  const accounts = await prisma.queueMaster.findMany({ select: { id: true } });
  const hadQueueData = Object.entries(counts).some(([name, value]) => name !== "AuditLog" && Number(value) > 0);
  for (const account of accounts) {
    const settings = await prisma.queueMasterSettings.findUnique({ where: { queueMasterId: account.id } });
    await prisma.queueWorkspace.upsert({ where: { queueMasterId: account.id }, create: { queueMasterId: account.id }, update: { lateArrivalCutoffAt: null, ...(hadQueueData ? { startedAt: new Date(), matchmakingRevision: { increment: 1 }, version: { increment: 1 } } : {}) } });
    await prisma.queueFeeConfig.upsert({ where: { queueMasterId: account.id }, create: { queueMasterId: account.id, mode: settings?.defaultFeeMode ?? "FIXED_PER_PLAYER", currencyCode: settings?.currencyCode ?? "PHP", fixedAmountPerPlayerMinor: settings?.defaultFixedFeeMinor ?? null, expectedQueueCostMinor: 0 }, update: { mode: settings?.defaultFeeMode ?? "FIXED_PER_PLAYER", currencyCode: settings?.currencyCode ?? "PHP", fixedAmountPerPlayerMinor: settings?.defaultFixedFeeMinor ?? null, expectedQueueCostMinor: 0, frozenAt: null } });
    await prisma.accountSyncState.upsert({ where: { queueMasterId: account.id }, create: { queueMasterId: account.id, schemaVersion: 2 }, update: { schemaVersion: 2, ...(hadQueueData ? { cloudRevision: { increment: 1 } } : {}), lastDeviceId: null, lastOperationId: null } });
  }
  console.log(`Migrated ${accounts.length} account(s) to empty queue workspaces.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
