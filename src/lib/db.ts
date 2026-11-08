import { Prisma, PrismaClient } from "@prisma/client";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomInt } from "node:crypto";
import { conflict } from "./errors.js";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const prisma = globalForPrisma.prisma ?? new PrismaClient();
const baseTransaction = prisma.$transaction.bind(prisma);
const transactionOptions = { maxWait: 10_000, timeout: 10_000 };
const transactions = new AsyncLocalStorage<Prisma.TransactionClient>();
const MAX_TRANSACTION_ATTEMPTS = 6;

// Existing helpers and nested transaction callbacks share the request's transaction.
export const database = new Proxy(prisma, {
  get(target, key) {
    const transaction = transactions.getStore();
    if (transaction && key === "$transaction")
      return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        callback(transaction);
    const source = transaction ?? target;
    const value = Reflect.get(source, key);
    return typeof value === "function" ? value.bind(source) : value;
  },
});

async function runTransaction<T>(
  callback: (transaction: Prisma.TransactionClient) => Promise<T>,
  options: { maxWait?: number; timeout?: number } = transactionOptions,
) {
  const current = transactions.getStore();
  if (current) return callback(current);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await baseTransaction((tx) => transactions.run(tx, () => callback(tx)), {
        ...transactionOptions,
        ...options,
      });
    } catch (error) {
      const retryable =
        (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") ||
        (error as any)?.code === "SYNC_CLOUD_CHANGED";
      if (!retryable) throw error;
      if (attempt >= MAX_TRANSACTION_ATTEMPTS - 1) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034")
          throw conflict(
            "SYNC_CLOUD_CHANGED",
            "Cloud data is busy. Retry syncing; pending work is preserved.",
          );
        throw error;
      }
      // Allow the winning MongoDB transaction to commit before contenders retry.
      const delay = Math.min(1000, 50 * 2 ** attempt) + randomInt(0, 50);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

Object.defineProperty(prisma, "$transaction", {
  configurable: true,
  value: (callbackOrQueries: unknown, options?: { maxWait?: number; timeout?: number }) =>
    typeof callbackOrQueries === "function"
      ? runTransaction(
          callbackOrQueries as (transaction: Prisma.TransactionClient) => Promise<unknown>,
          options,
        )
      : baseTransaction(callbackOrQueries as never, options as never),
});

export { prisma };

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export async function withTransactionRetry<T>(
  callback: (transaction: Prisma.TransactionClient) => Promise<T>,
  options: { maxWait?: number; timeout?: number } = transactionOptions,
) {
  return runTransaction(callback, options);
}
