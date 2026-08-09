export type FeeMode = "FIXED_PER_PLAYER" | "EQUAL_SPLIT";

export type CollectionMethodTotals = { CASH: number; EWALLET: number; OTHER: number };

export function collectionTotalsByPlayer(payments: ReadonlyArray<{ sessionPlayerId: string; kind: string; method?: string | null; amountMinor: number }>) {
  const totals = new Map<string, CollectionMethodTotals>();
  for (const payment of payments) {
    if (payment.kind !== "COLLECTION" || (payment.method !== "CASH" && payment.method !== "EWALLET" && payment.method !== "OTHER")) continue;
    const current = totals.get(payment.sessionPlayerId) ?? { CASH: 0, EWALLET: 0, OTHER: 0 };
    current[payment.method] += payment.amountMinor;
    totals.set(payment.sessionPlayerId, current);
  }
  return totals;
}

export function allocateEqualSplit(totalMinor: number, playerIds: string[]) {
  if (totalMinor < 0 || !Number.isInteger(totalMinor)) throw new Error("Fee total must be a non-negative integer.");
  const ids = [...new Set(playerIds)].sort();
  if (ids.length === 0) return new Map<string, number>();
  const base = Math.floor(totalMinor / ids.length);
  const remainder = totalMinor % ids.length;
  return new Map(ids.map((id, index) => [id, base + (index < remainder ? 1 : 0)]));
}
