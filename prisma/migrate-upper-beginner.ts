import { PrismaClient, SkillLevel } from "@prisma/client";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const weights: Record<SkillLevel, number> = {
  [SkillLevel.NEWBIE]: 1,
  [SkillLevel.BEGINNER]: 2,
  [SkillLevel.UPPER_BEGINNER]: 3,
  [SkillLevel.INTERMEDIATE]: 4,
  [SkillLevel.UPPER_INTERMEDIATE]: 5,
  [SkillLevel.ADVANCED]: 6,
};

async function main() {
  const counts = await Promise.all(Object.entries(weights).map(async ([level, weight]) => {
    const [players, queuePlayers] = await Promise.all([
      prisma.player.count({ where: { skillLevel: level as SkillLevel, NOT: { skillWeight: weight } } }),
      prisma.queuePlayer.count({ where: { skillLevelSnapshot: level as SkillLevel, NOT: { skillWeightSnapshot: weight } } }),
    ]);
    return { level, weight, players, queuePlayers };
  }));
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", counts }, null, 2));
  if (!apply) return;

  const mismatchFilters = Object.entries(weights).map(([level, weight]) => ({ skillLevel: level as SkillLevel, skillWeight: { not: weight } }));
  const queueMismatchFilters = Object.entries(weights).map(([level, weight]) => ({ skillLevelSnapshot: level as SkillLevel, skillWeightSnapshot: { not: weight } }));
  const [mismatchedPlayers, mismatchedQueuePlayers, workspaces] = await Promise.all([
    prisma.player.findMany({ where: { OR: mismatchFilters }, select: { queueMasterId: true } }),
    prisma.queuePlayer.findMany({ where: { OR: queueMismatchFilters }, select: { queueMasterId: true } }),
    prisma.queueWorkspace.findMany({ select: { queueMasterId: true, matchmakingAlgorithm: true } }),
  ]);
  const weightRepairAccounts = new Set([...mismatchedPlayers, ...mismatchedQueuePlayers].map((row) => row.queueMasterId));
  for (const { level, weight } of counts) {
    await prisma.player.updateMany({ where: { skillLevel: level as SkillLevel, NOT: { skillWeight: weight } }, data: { skillWeight: weight, version: { increment: 1 } } });
    await prisma.queuePlayer.updateMany({ where: { skillLevelSnapshot: level as SkillLevel, NOT: { skillWeightSnapshot: weight } }, data: { skillWeightSnapshot: weight, version: { increment: 1 } } });
  }
  for (const workspace of workspaces) {
    if (workspace.matchmakingAlgorithm === "v4-upper-beginner-strict-balance" && !weightRepairAccounts.has(workspace.queueMasterId)) continue;
    await prisma.queueWorkspace.update({ where: { queueMasterId: workspace.queueMasterId }, data: { matchmakingAlgorithm: "v4-upper-beginner-strict-balance", matchmakingRevision: { increment: 1 }, version: { increment: 1 } } });
    await prisma.accountSyncState.updateMany({ where: { queueMasterId: workspace.queueMasterId }, data: { cloudRevision: { increment: 1 }, version: { increment: 1 } } });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
