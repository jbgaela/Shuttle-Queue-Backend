import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { assertResetAllowed, resetData, resettableModelNames, type ResetDatabaseClient } from "../../prisma/reset-data.js";

test("reset targets every Prisma model except QueueMaster", () => {
  const models = resettableModelNames();
  assert.equal(models.includes(Prisma.ModelName.QueueMaster), false);
  assert.deepEqual(new Set(models), new Set(Object.values(Prisma.ModelName).filter((modelName) => modelName !== Prisma.ModelName.QueueMaster)));
});

test("reset is blocked in production", () => {
  assert.throws(() => assertResetAllowed("production"), /NODE_ENV=production/);
  assert.doesNotThrow(() => assertResetAllowed("development"));
});

test("reset deletes targeted models and preserves account rows", async () => {
  const deletedModels: string[] = [];
  const transaction = Object.fromEntries(resettableModelNames().map((modelName, index) => [
    `${modelName.slice(0, 1).toLowerCase()}${modelName.slice(1)}`,
    { deleteMany: async () => { deletedModels.push(modelName); return { count: index + 1 }; } },
  ]));
  const database: ResetDatabaseClient = {
    queueMaster: { count: async () => 2 },
    $transaction: async (callback) => callback(transaction),
  };

  const result = await resetData(database);

  assert.equal(result.preservedAccounts, 2);
  assert.deepEqual(deletedModels, resettableModelNames());
  assert.equal(Object.keys(result.deleted).length, resettableModelNames().length);
  assert.equal(Object.hasOwn(result.deleted, Prisma.ModelName.QueueMaster), false);
});
