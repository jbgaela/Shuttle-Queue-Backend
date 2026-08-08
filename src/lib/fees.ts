export type FeeMode = "FIXED_PER_PLAYER" | "EQUAL_SPLIT";

export function allocateEqualSplit(totalMinor: number, playerIds: string[]) {
  if (totalMinor < 0 || !Number.isInteger(totalMinor)) throw new Error("Fee total must be a non-negative integer.");
  const ids = [...new Set(playerIds)].sort();
  if (ids.length === 0) return new Map<string, number>();
  const base = Math.floor(totalMinor / ids.length);
  const remainder = totalMinor % ids.length;
  return new Map(ids.map((id, index) => [id, base + (index < remainder ? 1 : 0)]));
}

