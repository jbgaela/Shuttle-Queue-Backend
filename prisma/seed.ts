import argon2 from "argon2";
import { AccountRole, PrismaClient, QueueMasterStatus } from "@prisma/client";

const prisma = new PrismaClient();

const normalizeUsername = (value: string) => value.trim().normalize("NFKC").toLowerCase();

async function main() {
  const username = process.env.BOOTSTRAP_USERNAME?.trim();
  const password = process.env.BOOTSTRAP_PASSWORD;
  if (!username || !password) {
    throw new Error("BOOTSTRAP_USERNAME and BOOTSTRAP_PASSWORD are required for provisioning.");
  }
  const normalizedUsername = normalizeUsername(username);
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  // Backfill records created before roles existed without changing any existing
  // Super Admin role on subsequent runs.
  await prisma.$runCommandRaw({ update: "QueueMaster", updates: [{ q: { role: { $exists: false } }, u: { $set: { role: AccountRole.QUEUE_MASTER } }, multi: true }] });
  const existing = await prisma.queueMaster.findUnique({ where: { normalizedUsername } });
  if (existing) {
    await prisma.$transaction(async (tx) => {
      await tx.queueMaster.update({ where: { id: existing.id }, data: { role: AccountRole.SUPER_ADMIN, status: QueueMasterStatus.ACTIVE, passwordHash, passwordChangedAt: new Date(), version: { increment: 1 } } });
      await tx.authSession.updateMany({ where: { queueMasterId: existing.id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: "bootstrap-recovery" } });
    });
    console.log("Bootstrap account promoted to Super Admin and its password was reset.");
  } else {
    await prisma.queueMaster.create({
      data: { username, normalizedUsername, passwordHash, role: AccountRole.SUPER_ADMIN, settings: { create: {} } },
    });
    console.log("Super Admin provisioned.");
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Provisioning failed.");
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
