import { Prisma, PrismaClient } from "@prisma/client";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const PRESERVED_MODEL = Prisma.ModelName.QueueMaster;
const TRANSACTION_TIMEOUT_MS = 60_000;
const DELETION_PRIORITY = [
  Prisma.ModelName.MatchGame,
  Prisma.ModelName.MatchScoreRevision,
  Prisma.ModelName.MatchParticipant,
  Prisma.ModelName.Match,
  Prisma.ModelName.Payment,
  Prisma.ModelName.QueuePlayer,
  Prisma.ModelName.Player,
  Prisma.ModelName.Court,
] as const;

type ModelDelegate = {
  deleteMany: () => Promise<{ count: number }>;
};

export type ResetDatabaseClient = {
  queueMaster: {
    count: () => Promise<number>;
  };
  $transaction: <T>(
    callback: (transaction: unknown) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ) => Promise<T>;
};

export function resettableModelNames(): string[] {
  const modelNames = Object.values(Prisma.ModelName).filter((modelName) => modelName !== PRESERVED_MODEL);
  const prioritized = DELETION_PRIORITY.filter((modelName) => modelNames.includes(modelName));
  const prioritizedSet = new Set<string>(prioritized);
  return [...prioritized, ...modelNames.filter((modelName) => !prioritizedSet.has(modelName))];
}

export function assertResetAllowed(nodeEnv = process.env.NODE_ENV): void {
  if (nodeEnv === "production") {
    throw new Error("Refusing to reset database data while NODE_ENV=production.");
  }
}

function delegateName(modelName: string): string {
  return `${modelName.slice(0, 1).toLowerCase()}${modelName.slice(1)}`;
}

export async function resetData(database: ResetDatabaseClient): Promise<{ preservedAccounts: number; deleted: Record<string, number> }> {
  const preservedAccounts = await database.queueMaster.count();
  const deleted = await database.$transaction(async (transaction) => {
    const delegates = transaction as Record<string, ModelDelegate>;
    const counts: Record<string, number> = {};
    for (const modelName of resettableModelNames()) {
      const delegate = delegates[delegateName(modelName)];
      if (!delegate) throw new Error(`Prisma delegate not found for model ${modelName}.`);
      counts[modelName] = (await delegate.deleteMany()).count;
    }
    return counts;
  }, { maxWait: 10_000, timeout: TRANSACTION_TIMEOUT_MS });
  return { preservedAccounts, deleted };
}

async function main(): Promise<void> {
  assertResetAllowed();
  const prisma = new PrismaClient();
  try {
    const result = await resetData(prisma as unknown as ResetDatabaseClient);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Database reset failed.");
    process.exitCode = 1;
  });
}
