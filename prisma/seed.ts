import argon2 from "argon2";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const normalizeUsername = (value: string) => value.trim().normalize("NFKC").toLowerCase();

async function main() {
  const username = process.env.BOOTSTRAP_USERNAME?.trim();
  const password = process.env.BOOTSTRAP_PASSWORD;
  if (!username || !password) {
    throw new Error("BOOTSTRAP_USERNAME and BOOTSTRAP_PASSWORD are required for provisioning.");
  }
  const normalizedUsername = normalizeUsername(username);
  const existing = await prisma.queueMaster.findUnique({ where: { normalizedUsername } });
  if (existing) {
    throw new Error("The requested Queue Master username already exists.");
  }
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await prisma.queueMaster.create({
    data: {
      username,
      normalizedUsername,
      passwordHash,
      settings: { create: {} },
    },
  });
  console.log("Queue Master provisioned.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Provisioning failed.");
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());

