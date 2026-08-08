import { Prisma, PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const prisma = globalForPrisma.prisma ?? new PrismaClient();
const baseTransaction = prisma.$transaction.bind(prisma);
const transactionOptions = { maxWait: 10_000, timeout: 10_000 };

async function runTransaction<T>(callback: (transaction: Prisma.TransactionClient) => Promise<T>, options: { maxWait?: number; timeout?: number } = transactionOptions) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await baseTransaction(callback, { ...transactionOptions, ...options });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034" || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

Object.defineProperty(prisma, "$transaction", {
  configurable: true,
  value: (callbackOrQueries: unknown, options?: { maxWait?: number; timeout?: number }) => typeof callbackOrQueries === "function"
    ? runTransaction(callbackOrQueries as (transaction: Prisma.TransactionClient) => Promise<unknown>, options)
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
