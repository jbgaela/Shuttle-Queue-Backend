import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/db.js";
import { passwordHash } from "../../src/lib/auth.js";
import { persistSyncSnapshot } from "../../src/lib/sync-persistence.js";
import { withTransactionRetry } from "../../src/lib/db.js";

if (!process.env.DATABASE_URL?.startsWith("mongodb://mongo:27017/offline_sync?"))
  throw new Error("Integration tests require disposable Docker MongoDB.");
const server = createApp().listen(0);
let url: string;
const clients: Array<{ id: string; cookie: string; csrf: string }> = [];
async function call(
  client: (typeof clients)[number],
  path: string,
  body?: unknown,
  method = "PUT",
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${url}/api/v2${path}`, {
    method: body === undefined ? "GET" : method,
    headers: {
      cookie: client.cookie,
      origin: "http://localhost:3100",
      "content-type": "application/json",
      "x-csrf-token": client.csrf,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, ...((await response.json()) as any) };
}
const upload = (client: (typeof clients)[number], remote: any, snapshot: any, extra: any = {}) =>
  call(client, "/sync/snapshot", {
    schemaVersion: 3,
    deviceId: "integration-device",
    operationId: randomUUID(),
    baseCloudRevision: remote.cloudRevision,
    force: false,
    snapshot: { ...snapshot, schemaVersion: 3 },
    baseSnapshot: remote.snapshot,
    auditEvents: [],
    ...extra,
  });
before(async () => {
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (let index = 0; index < 2; index += 1) {
    const username = `docker-sync-${index}`;
    const account = await prisma.queueMaster.create({
      data: {
        username,
        normalizedUsername: username,
        passwordHash: await passwordHash(process.env.SYNC_TEST_PASSWORD!),
        settings: { create: {} },
      },
    });
    const response = await fetch(`${url}/api/v2/auth/login`, {
      method: "POST",
      headers: { origin: "http://localhost:3100", "content-type": "application/json" },
      body: JSON.stringify({ username, password: process.env.SYNC_TEST_PASSWORD }),
    });
    const payload: any = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    clients.push({
      id: account.id,
      cookie: response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; "),
      csrf: payload.data.csrfToken,
    });
  }
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

test("real MongoDB: sync snapshots negotiate gzip without changing the envelope", async () => {
  const client = clients[0];
  const response = await fetch(`${url}/api/v2/sync/snapshot`, {
    headers: {
      cookie: client.cookie,
      origin: "http://localhost:3100",
      "accept-encoding": "gzip",
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-encoding"), "gzip");
  const payload: any = await response.json();
  assert.equal(payload.data.schemaVersion, 2);
  assert.equal(payload.data.snapshot.queueMasterId, client.id);
  assert.equal(typeof payload.requestId, "string");
});

test("real MongoDB: ten successive snapshots and accepted-operation replay", async () => {
  const client = clients[0];
  for (let cycle = 0; cycle < 10; cycle += 1) {
    const remote = (await call(client, "/sync/snapshot")).data;
    const snapshot = structuredClone(remote.snapshot);
    snapshot.players.push({
      id: randomUUID(),
      displayName: `Cycle ${cycle}`,
      gender: "MALE",
      skillLevel: "BEGINNER",
      skillWeight: 2,
      status: "ACTIVE",
    });
    const operationId = randomUUID();
    const result = await upload(client, remote, snapshot, { operationId });
    assert.equal(result.status, 200, JSON.stringify(result));
    const replay = await upload(client, remote, snapshot, { operationId });
    assert.equal(replay.status, 200, JSON.stringify(replay));
    assert.equal(replay.data.alreadyApplied, true);
    assert.equal(replay.data.cloudRevision, result.data.cloudRevision);
    assert.equal(await prisma.player.count({ where: { queueMasterId: client.id } }), cycle + 1);
  }
});
test("real MongoDB: valid player-name swaps preserve existing identities", async () => {
  const client = clients[0];
  const remote = (await call(client, "/sync/snapshot")).data;
  const snapshot = structuredClone(remote.snapshot);
  [snapshot.players[0].displayName, snapshot.players[1].displayName] = [
    snapshot.players[1].displayName,
    snapshot.players[0].displayName,
  ];
  const result = await upload(client, remote, snapshot);
  assert.equal(result.status, 200, JSON.stringify(result));
  for (const player of snapshot.players)
    assert.equal(
      (await prisma.player.findUniqueOrThrow({ where: { id: player.id } })).displayName,
      player.displayName,
    );
});
test("real MongoDB: online writes do not downgrade an upgraded account", async () => {
  const client = clients[0];
  const before = await prisma.accountSyncState.findUniqueOrThrow({
    where: { queueMasterId: client.id },
  });
  const result = await call(
    client,
    "/players",
    { displayName: "Online addition", gender: "FEMALE", skillLevel: "BEGINNER" },
    "POST",
  );
  assert.equal(result.status, 201, JSON.stringify(result));
  const deadline = Date.now() + 2000;
  let current = await prisma.accountSyncState.findUniqueOrThrow({
    where: { queueMasterId: client.id },
  });
  while (current.cloudRevision <= before.cloudRevision && Date.now() < deadline)
    current = await prisma.accountSyncState.findUniqueOrThrow({
      where: { queueMasterId: client.id },
    });
  assert.ok(current.cloudRevision > before.cloudRevision);
  assert.equal(current.schemaVersion, 3);
});
test("real MongoDB: legacy v2 colliding record IDs receive safe identity errors", async () => {
  const client = clients[1];
  const remote = (await call(client, "/sync/snapshot")).data;
  const foreign = await prisma.player.findFirstOrThrow({ where: { queueMasterId: clients[0].id } });
  const snapshot = structuredClone(remote.snapshot);
  snapshot.players.push({
    id: foreign.id,
    displayName: "Colliding identity",
    gender: "MALE",
    skillLevel: "BEGINNER",
    skillWeight: 2,
    status: "ACTIVE",
  });
  const result = await call(client, "/sync/snapshot", {
    schemaVersion: 2,
    deviceId: "legacy-device",
    operationId: randomUUID(),
    baseCloudRevision: remote.cloudRevision,
    force: false,
    snapshot,
    auditEvents: [],
  });
  assert.equal(result.status, 409, JSON.stringify(result));
  assert.equal(result.error.code, "SYNC_IDENTITY_CONFLICT", JSON.stringify(result));
});
test("real MongoDB: incompatible concurrent profile edits roll back with review details", async () => {
  const client = clients[0];
  const base = (await call(client, "/sync/snapshot")).data;
  const local = structuredClone(base.snapshot);
  const cloud = structuredClone(base.snapshot);
  local.players[0].displayName = "Local edit";
  cloud.players[0].displayName = "Cloud edit";
  assert.equal((await upload(client, base, cloud)).status, 200);
  const result = await upload(client, base, local);
  assert.equal(result.status, 409, JSON.stringify(result));
  assert.equal(result.error.code, "SYNC_REVIEW_REQUIRED");
  assert.ok(result.error.details.conflicts.some((item: any) => item.field === "displayName"));
  assert.equal(
    (await prisma.player.findUniqueOrThrow({ where: { id: local.players[0].id } })).displayName,
    "Cloud edit",
  );
});
test("real MongoDB: malformed v3 and foreign IDs are rejected atomically", async () => {
  const client = clients[1];
  const remote = (await call(client, "/sync/snapshot")).data;
  const malformed = await upload(client, remote, {
    ...remote.snapshot,
    matches: [{ id: "invalid" }],
  });
  assert.equal(malformed.status, 422, JSON.stringify(malformed));
  const foreign = await prisma.player.findFirstOrThrow({ where: { queueMasterId: clients[0].id } });
  const snapshot = structuredClone(remote.snapshot);
  snapshot.players.push({
    id: foreign.id,
    displayName: "Foreign ID",
    gender: "MALE",
    skillLevel: "BEGINNER",
    skillWeight: 2,
    status: "ACTIVE",
  });
  const denied = await upload(client, remote, snapshot);
  assert.equal(denied.status, 409, JSON.stringify(denied));
  assert.equal(await prisma.player.count({ where: { queueMasterId: client.id } }), 0);
});

test("real MongoDB: conflicting offline scores can be reviewed without revision-key collisions", async () => {
  const client = clients[0];
  const base = (await call(client, "/sync/snapshot")).data;
  const snapshot = structuredClone(base.snapshot);
  const matchId = randomUUID(),
    revisionId = randomUUID(),
    courtId = randomUUID();
  const at = new Date().toISOString();
  const players = snapshot.players.slice(0, 4);
  snapshot.queuePlayers = players.map((player: any) => ({
    id: randomUUID(),
    playerId: player.id,
    displayName: player.displayName,
    gender: player.gender,
    skillLevel: player.skillLevel,
    skillWeight: player.skillWeight,
    status: "WAITING",
    queueEnteredAt: at,
    checkedInAt: at,
    checkedOutAt: null,
    restStartedAt: null,
    lastMatchEndedAt: null,
    currentMatchId: null,
    matchesPlayed: 0,
    wins: 0,
    losses: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    amountDueMinor: 0,
    manualPriority: 0,
    priorityReason: null,
    latePenaltyState: null,
    latePenaltyAppliedAt: null,
    version: 1,
  }));
  snapshot.courts = [
    {
      id: courtId,
      name: "Score court",
      normalizedName: "score court",
      displayOrder: 0,
      status: "AVAILABLE",
      currentMatchId: null,
      closedAt: null,
      version: 1,
    },
  ];
  snapshot.matches = [
    {
      id: matchId,
      courtId,
      courtIdSnapshot: courtId,
      courtNameSnapshot: "Score court",
      status: "COMPLETED",
      source: "MANUAL",
      matchmakingMode: null,
      algorithmVersion: null,
      suggestionKey: null,
      suggestionExplanation: null,
      pointsToWin: 31,
      winBy: 1,
      scoreCap: null,
      bestOf: 1,
      queuedAt: at,
      startedAt: at,
      completedAt: at,
      cancelledAt: null,
      cancellationReason: null,
      winnerTeam: "A",
      currentRevisionId: revisionId,
      version: 1,
      participants: snapshot.queuePlayers.map((row: any, index: number) => ({
        id: randomUUID(),
        matchId,
        queuePlayerId: row.id,
        team: index < 2 ? "A" : "B",
        teamSlot: (index % 2) + 1,
        priorQueueEnteredAt: at,
      })),
      scoreRevisions: [
        {
          id: revisionId,
          matchId,
          revisionNumber: 1,
          winnerTeam: "A",
          reason: null,
          supersedesRevisionId: null,
          createdAt: at,
          games: [
            {
              id: randomUUID(),
              scoreRevisionId: revisionId,
              gameNumber: 1,
              teamAScore: 31,
              teamBScore: 10,
              winnerTeam: "A",
            },
          ],
        },
      ],
    },
  ];
  const seeded = await upload(client, base, snapshot);
  assert.equal(seeded.status, 200, JSON.stringify(seeded));
  const baseline = (await call(client, "/sync/snapshot")).data;
  const corrected = (score: number) => {
    const next = structuredClone(baseline.snapshot);
    const id = randomUUID();
    next.matches[0].currentRevisionId = id;
    next.matches[0].scoreRevisions.push({
      id,
      matchId,
      revisionNumber: 2,
      winnerTeam: "A",
      reason: "Offline correction",
      supersedesRevisionId: revisionId,
      createdAt: at,
      games: [
        {
          id: randomUUID(),
          scoreRevisionId: id,
          gameNumber: 1,
          teamAScore: 31,
          teamBScore: score,
          winnerTeam: "A",
        },
      ],
    });
    return next;
  };
  const cloud = corrected(15),
    local = corrected(20);
  assert.equal((await upload(client, baseline, cloud)).status, 200);
  const review = await upload(client, baseline, local);
  assert.equal(review.status, 409, JSON.stringify(review));
  const stateBefore = await prisma.accountSyncState.findUniqueOrThrow({
    where: { queueMasterId: client.id },
  });
  const resolved = await upload(client, baseline, local, {
    resolutions: Object.fromEntries(
      review.error.details.conflicts.map((item: any) => [item.key, { choice: "local" }]),
    ),
    reviewedCloudRevision: review.error.details.cloudRevision,
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved));
  assert.equal(await prisma.matchScoreRevision.count({ where: { matchId } }), 2);
  assert.equal(
    (await prisma.accountSyncState.findUniqueOrThrow({ where: { queueMasterId: client.id } }))
      .cloudRevision,
    stateBefore.cloudRevision + 1,
  );
  assert.ok(
    resolved.data.snapshot.matches[0].scoreRevisions.some(
      (row: any) => row.id === local.matches[0].currentRevisionId,
    ),
  );
});

test("real MongoDB: a failure after reconciliation rolls back records, revision and receipt", async () => {
  const client = clients[0];
  const remote = (await call(client, "/sync/snapshot")).data;
  const snapshot = structuredClone(remote.snapshot);
  const playerId = randomUUID(),
    operationId = randomUUID();
  snapshot.players.push({
    id: playerId,
    displayName: "Rolled back",
    gender: "MALE",
    skillLevel: "BEGINNER",
    skillWeight: 2,
    status: "ACTIVE",
  });
  const before = await prisma.accountSyncState.findUniqueOrThrow({
    where: { queueMasterId: client.id },
  });
  await assert.rejects(
    () =>
      withTransactionRetry(async (tx) => {
        await persistSyncSnapshot(
          tx,
          {
            schemaVersion: 3,
            deviceId: "rollback",
            operationId,
            baseCloudRevision: remote.cloudRevision,
            snapshot,
            baseSnapshot: remote.snapshot,
            force: false,
            auditEvents: [{ action: "ROLLBACK_TEST" }],
          },
          client.id,
        );
        throw new Error("Injected failure after writes");
      }),
    /Injected failure/,
  );
  assert.equal(await prisma.player.findUnique({ where: { id: playerId } }), null);
  assert.equal(
    await prisma.syncOperationReceipt.findUnique({
      where: { queueMasterId_operationId: { queueMasterId: client.id, operationId } },
    }),
    null,
  );
  assert.equal(
    await prisma.auditLog.count({ where: { queueMasterId: client.id, action: "ROLLBACK_TEST" } }),
    0,
  );
  assert.equal(
    (await prisma.accountSyncState.findUniqueOrThrow({ where: { queueMasterId: client.id } }))
      .cloudRevision,
    before.cloudRevision,
  );
});

test("real MongoDB: stale conflict resolutions cannot overwrite intervening cloud work", async () => {
  const client = clients[0];
  const remote = (await call(client, "/sync/snapshot")).data;
  const snapshot = structuredClone(remote.snapshot);
  snapshot.players[0].displayName = "Stale resolution";
  const result = await upload(client, remote, snapshot, {
    resolutions: { "players/unused/displayName": { choice: "local" } },
    reviewedCloudRevision: remote.cloudRevision - 1,
  });
  assert.equal(result.status, 409);
  assert.equal(result.error.code, "SYNC_REVIEW_STALE");
});

test("real MongoDB: ten pairs of simultaneous uploads merge with one receipt and audit per upload", async () => {
  const client = clients[0];
  for (let round = 0; round < 10; round += 1) {
    const base = (await call(client, "/sync/snapshot")).data;
    const beforeReceipts = await prisma.syncOperationReceipt.count({
      where: { queueMasterId: client.id },
    });
    const left = structuredClone(base.snapshot),
      right = structuredClone(base.snapshot);
    const additions = ["A", "B"].map((side) => ({
      id: randomUUID(),
      displayName: "Concurrent " + round + " " + side,
      gender: "MALE",
      skillLevel: "BEGINNER",
      skillWeight: 2,
      status: "ACTIVE",
    }));
    left.players.push(additions[0]);
    right.players.push(additions[1]);
    const results = await Promise.all([
      upload(client, base, left, {
        deviceId: "left",
        auditEvents: [{ action: "PARALLEL_UPLOAD", entityId: additions[0].id }],
      }),
      upload(client, base, right, {
        deviceId: "right",
        auditEvents: [{ action: "PARALLEL_UPLOAD", entityId: additions[1].id }],
      }),
    ]);
    for (const result of results) assert.equal(result.status, 200, JSON.stringify(result));
    for (const result of results)
      assert.ok(
        result.data.snapshot.audits.some(
          (event: any) =>
            event.action === "PARALLEL_UPLOAD" &&
            additions.some((addition) => addition.id === event.entityId),
        ),
      );
    assert.equal(
      await prisma.player.count({
        where: { queueMasterId: client.id, id: { in: additions.map((row) => row.id) } },
      }),
      2,
    );
    assert.equal(
      await prisma.syncOperationReceipt.count({ where: { queueMasterId: client.id } }),
      beforeReceipts + 2,
    );
    assert.equal(
      await prisma.auditLog.count({
        where: {
          queueMasterId: client.id,
          action: "PARALLEL_UPLOAD",
          entityId: { in: additions.map((row) => row.id) },
        },
      }),
      2,
    );
    assert.equal(
      (await prisma.accountSyncState.findUniqueOrThrow({ where: { queueMasterId: client.id } }))
        .cloudRevision,
      base.cloudRevision + 2,
    );
  }
});

test("real MongoDB: a stale session cannot silently restore queue records after reset", async () => {
  const client = clients[0];
  const base = (await call(client, "/sync/snapshot")).data;
  const local = structuredClone(base.snapshot);
  local.matches[0].cancellationReason = "A pending edit from the previous session";
  const reset = await call(client, "/workspace/start-fresh", {}, "POST", {
    "if-match": String(base.snapshot.workspace.version),
  });
  assert.equal(reset.status, 200, JSON.stringify(reset));
  const stale = await upload(client, base, local);
  assert.equal(stale.status, 409, JSON.stringify(stale));
  assert.equal(stale.error.code, "SYNC_REVIEW_REQUIRED");
  assert.equal(await prisma.match.count({ where: { queueMasterId: client.id } }), 0);
});

test("real MongoDB: legacy receipts survive later operations and cannot downgrade v3", async () => {
  const client = clients[1];
  const remote = (await call(client, "/sync/snapshot")).data;
  const snapshot = structuredClone(remote.snapshot);
  const playerId = randomUUID(),
    operationId = randomUUID();
  snapshot.players.push({
    id: playerId,
    displayName: "Legacy original",
    gender: "MALE",
    skillLevel: "BEGINNER",
    skillWeight: 2,
    status: "ACTIVE",
  });
  const body = {
    schemaVersion: 2,
    deviceId: "legacy",
    operationId,
    baseCloudRevision: remote.cloudRevision,
    force: false,
    snapshot,
    auditEvents: [{ action: "LEGACY_ONCE" }],
  };
  const first = await call(client, "/sync/snapshot", body);
  assert.equal(first.status, 200, JSON.stringify(first));
  const next = structuredClone(snapshot);
  next.players[0].displayName = "Legacy latest";
  const later = await call(client, "/sync/snapshot", {
    ...body,
    operationId: randomUUID(),
    baseCloudRevision: first.data.cloudRevision,
    snapshot: next,
    auditEvents: [],
  });
  assert.equal(later.status, 200, JSON.stringify(later));
  const replay = await call(client, "/sync/snapshot", body);
  assert.equal(replay.status, 200, JSON.stringify(replay));
  assert.equal(replay.data.alreadyApplied, true);
  assert.equal(
    (await prisma.player.findUniqueOrThrow({ where: { id: playerId } })).displayName,
    "Legacy latest",
  );
  assert.equal(
    await prisma.auditLog.count({ where: { queueMasterId: client.id, action: "LEGACY_ONCE" } }),
    1,
  );
  const baseline = (await call(client, "/sync/snapshot")).data;
  assert.equal((await upload(client, baseline, baseline.snapshot)).status, 200);
  const denied = await call(client, "/sync/snapshot", body);
  assert.equal(denied.status, 409);
  assert.equal(denied.error.code, "SYNC_CLIENT_UPGRADE_REQUIRED");
});
