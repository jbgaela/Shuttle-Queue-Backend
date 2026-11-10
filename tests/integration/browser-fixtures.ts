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
      "readiness",
      "cache-repair",
      "asset-html-response",
      "missing-offline-file",
      "missing-account-data",
      "account-a",
      "idb-write-failure",
      "version-update",
      "ui-continuity",
      ...(browser === "chromium" ? ["sync-deadline"] : []),
      ...Array.from({ length: 20 }, (_, index) => `load-${String(index + 1).padStart(2, "0")}`),
    ]) {
      if (scenario.startsWith("load-") && browser !== "chromium") continue;
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
      const seededAt = new Date();
      const playerCount = scenario.startsWith("load-") ? 100 : 4;
      const playerIds = Array.from({ length: playerCount }, () => randomUUID());
      const queueIds = Array.from({ length: playerCount }, () => randomUUID());
      await prisma.player.createMany({
        data: playerIds.map((id, index) => ({
          id,
          queueMasterId: account.id,
          displayName: `Seed ${index + 1}`,
          normalizedName: `seed ${index + 1}`,
          gender: "MALE",
          skillLevel: "BEGINNER",
          skillWeight: 2,
        })),
      });
      await prisma.queuePlayer.createMany({
        data: queueIds.map((id, index) => ({
          id,
          queueMasterId: account.id,
          playerId: playerIds[index]!,
          displayNameSnapshot: `Seed ${index + 1}`,
          normalizedNameSnapshot: `seed ${index + 1}`,
          genderSnapshot: "MALE",
          skillLevelSnapshot: "BEGINNER",
          skillWeightSnapshot: 2,
          status: "WAITING",
          checkedInAt: seededAt,
          queueEnteredAt: seededAt,
          ...(scenario.startsWith("load-")
            ? {
                lastMatchEndedAt: new Date(seededAt.getTime() - Math.floor(index / 4) * 60_000),
                matchesPlayed: 20,
                wins: index % 4 < 2 ? 20 : 0,
                losses: index % 4 < 2 ? 0 : 20,
                pointsFor: index % 4 < 2 ? 620 : 240,
                pointsAgainst: index % 4 < 2 ? 240 : 620,
              }
            : {}),
          amountDueMinor: 5000,
        })),
      });
      const synergyTeamId = randomUUID();
      await prisma.synergyTeam.create({
        data: {
          id: synergyTeamId,
          queueMasterId: account.id,
          queuePlayerIds: queueIds.slice(0, 2),
        },
      });
      const courtCount = scenario.startsWith("load-") ? 10 : 1;
      const courtIds = Array.from({ length: courtCount }, () => randomUUID());
      await prisma.court.createMany({
        data: courtIds.map((id, index) => ({
          id,
          queueMasterId: account.id,
          name: `Court ${index + 1}`,
          normalizedName: `court ${index + 1}`,
        })),
      });
      if (scenario.startsWith("load-")) {
        const matches = Array.from({ length: 500 }, (_, index) => {
          const matchId = randomUUID();
          const revisionId = randomUUID();
          const completedAt = new Date(seededAt.getTime() - index * 60_000);
          return {
            match: {
              id: matchId,
              revisionId,
              queueMasterId: account.id,
              courtId: courtIds[index % courtIds.length]!,
              courtIdSnapshot: courtIds[index % courtIds.length]!,
              courtNameSnapshot: `Court ${(index % courtIds.length) + 1}`,
              status: "COMPLETED" as const,
              source: "MANUAL" as const,
              pointsToWin: 31,
              winBy: 2,
              bestOf: 1,
              queuedAt: new Date(completedAt.getTime() - 40 * 60_000),
              startedAt: new Date(completedAt.getTime() - 30 * 60_000),
              completedAt,
              winnerTeam: "A" as const,
              currentRevisionId: revisionId,
              createdAt: new Date(completedAt.getTime() - 40 * 60_000),
              updatedAt: completedAt,
            },
            participants: [0, 1, 2, 3].map((slot) => ({
              id: randomUUID(),
              matchId,
              queuePlayerId: queueIds[(index * 4 + slot) % queueIds.length]!,
              team: slot < 2 ? ("A" as const) : ("B" as const),
              teamSlot: (slot % 2) + 1,
              createdAt: new Date(completedAt.getTime() - 30 * 60_000),
            })),
          };
        });
        await prisma.match.createMany({
          data: matches.map(({ match: { revisionId: _revisionId, ...match } }) => match),
        });
        await prisma.matchParticipant.createMany({
          data: matches.flatMap(({ participants }) => participants),
        });
        await prisma.matchScoreRevision.createMany({
          data: matches.map(({ match }) => ({
            id: match.revisionId,
            matchId: match.id,
            revisionNumber: 1,
            winnerTeam: "A",
            reason: "Disposable load fixture",
            createdByQueueMasterId: account.id,
            createdAt: match.completedAt,
          })),
        });
        await prisma.matchGame.createMany({
          data: matches.map(({ match }) => ({
            id: randomUUID(),
            scoreRevisionId: match.revisionId,
            gameNumber: 1,
            teamAScore: 31,
            teamBScore: 12,
            winnerTeam: "A",
            createdAt: match.completedAt,
          })),
        });
        const paymentRows = Array.from({ length: 1_000 }, (_, index) => ({
          id: randomUUID(),
          queueMasterId: account.id,
          queuePlayerId: queueIds[index % queueIds.length]!,
          kind: "COLLECTION" as const,
          method: "CASH" as const,
          amountMinor: 5000,
          recordedById: account.id,
          occurredAt: new Date(seededAt.getTime() - index * 60_000),
          createdAt: seededAt,
        }));
        await prisma.payment.createMany({ data: paymentRows });
        const auditRows = Array.from({ length: 1_000 }, (_, index) => ({
          id: randomUUID(),
          queueMasterId: account.id,
          action: index % 2 === 0 ? "MATCH_COMPLETED" : "PAYMENT_RECORDED",
          entityType: index % 2 === 0 ? "MATCH" : "PAYMENT",
          entityId:
            index % 2 === 0
              ? matches[Math.floor(index / 2) % matches.length]!.match.id
              : `qualification-payment-${Math.floor(index / 2)}`,
          reason: "Deterministic offline qualification fixture",
          beforeJson: { revision: 0, status: "IN_PROGRESS" },
          afterJson: { revision: 1, status: "COMPLETED", score: [31, 12] },
          requestId: `qualification-fixture-${index}`,
          createdAt: new Date(seededAt.getTime() - index * 30_000),
        }));
        await prisma.auditLog.createMany({ data: auditRows });

        const clock = {
          at: seededAt.toISOString(),
          deviceId: `qualification-fixture-${account.id}`,
          sequence: 0,
        };
        const records: Record<string, { clock: typeof clock }> = {};
        const collections = [
          ["players", playerIds],
          ["queuePlayers", queueIds],
          ["synergyTeams", [synergyTeamId]],
          ["courts", courtIds],
          ["matches", matches.map(({ match }) => match.id)],
          ["payments", paymentRows.map(({ id }) => id)],
          ["audits", auditRows.map(({ id }) => id)],
        ] as const;
        for (const [collection, ids] of collections)
          for (const id of ids) records[`${collection}/${id}`] = { clock };
        records["settings/main"] = { clock };
        records["workspace/main"] = { clock };
        records["feeConfig/main"] = { clock };
        await prisma.accountSyncState.create({
          data: {
            queueMasterId: account.id,
            schemaVersion: 3,
            mergeMetadata: { version: 3, records },
          },
        });
      }
    }
} finally {
  await prisma.$disconnect();
}
