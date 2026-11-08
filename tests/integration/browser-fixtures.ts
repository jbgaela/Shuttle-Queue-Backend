import { randomUUID } from "node:crypto";
import { prisma } from "../../src/lib/db.js";
import { passwordHash } from "../../src/lib/auth.js";

if (!process.env.DATABASE_URL?.startsWith("mongodb://mongo:27017/offline_sync?"))
  throw new Error("Browser fixtures require disposable Docker MongoDB.");
try {
  const hash = await passwordHash(process.env.SYNC_TEST_PASSWORD!);
  for (const browser of ["chromium", "firefox", "webkit"])
    for (const scenario of [
      "cycles",
      "replay",
      "inflight",
      "conflicts",
      "tabs",
      "legacy",
      "failure",
      "session",
      "reload",
    ]) {
      const username = `browser-${browser}-${scenario}`;
      const account = await prisma.queueMaster.create({
        data: {
          username,
          normalizedUsername: username,
          passwordHash: hash,
          settings: { create: {} },
          workspace: { create: {} },
          feeConfig: { create: { mode: "FIXED_PER_PLAYER", fixedAmountPerPlayerMinor: 5000 } },
        },
      });
      const queueIds: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const player = await prisma.player.create({
          data: {
            queueMasterId: account.id,
            displayName: `Seed ${index + 1}`,
            normalizedName: `seed ${index + 1}`,
            gender: "MALE",
            skillLevel: "BEGINNER",
            skillWeight: 2,
          },
        });
        const queue = await prisma.queuePlayer.create({
          data: {
            queueMasterId: account.id,
            playerId: player.id,
            displayNameSnapshot: player.displayName,
            normalizedNameSnapshot: player.normalizedName,
            genderSnapshot: player.gender,
            skillLevelSnapshot: player.skillLevel,
            skillWeightSnapshot: player.skillWeight,
            status: "WAITING",
            checkedInAt: new Date(),
            queueEnteredAt: new Date(),
            amountDueMinor: 5000,
          },
        });
        queueIds.push(queue.id);
      }
      await prisma.synergyTeam.create({
        data: { id: randomUUID(), queueMasterId: account.id, queuePlayerIds: queueIds.slice(0, 2) },
      });
      await prisma.court.create({
        data: { queueMasterId: account.id, name: "Court 1", normalizedName: "court 1" },
      });
    }
} finally {
  await prisma.$disconnect();
}
