import { prisma } from "../../src/lib/db.js";
if (!process.env.DATABASE_URL?.startsWith("mongodb://mongo:27017/offline_sync?"))
  throw new Error("Inspection requires disposable Docker MongoDB.");
const queueMasterId = process.argv[2];
try {
  const [players, queuePlayers, matches, courts, payments, receipts, audits, state] =
    await Promise.all([
      prisma.player.findMany({
        where: { queueMasterId },
        select: { id: true, normalizedName: true, displayName: true },
      }),
      prisma.queuePlayer.findMany({
        where: { queueMasterId },
        select: {
          id: true,
          playerId: true,
          matchesPlayed: true,
          wins: true,
          losses: true,
          pointsFor: true,
          pointsAgainst: true,
        },
      }),
      prisma.match.findMany({
        where: { queueMasterId },
        include: { participants: true, scoreRevisions: { include: { games: true } } },
      }),
      prisma.court.findMany({ where: { queueMasterId }, select: { id: true } }),
      prisma.payment.findMany({
        where: { queueMasterId },
        select: { id: true, amountMinor: true },
      }),
      prisma.syncOperationReceipt.count({ where: { queueMasterId } }),
      prisma.auditLog.count({ where: { queueMasterId } }),
      prisma.accountSyncState.findUnique({
        where: { queueMasterId },
        select: { cloudRevision: true, schemaVersion: true },
      }),
    ]);
  const summary = process.argv[3] === "--summary";
  if (summary) {
    console.log(
      JSON.stringify({
        players: players.length,
        queuePlayers: queuePlayers.length,
        matches: matches.length,
        courts: courts.length,
        payments: payments.length,
        receipts,
        audits,
        state,
      }),
    );
  } else {
    console.log(
      JSON.stringify({ players, queuePlayers, matches, courts, payments, receipts, audits, state }),
    );
  }
} finally {
  await prisma.$disconnect();
}
