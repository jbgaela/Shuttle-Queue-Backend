export function stalePlayerFilter(playerIds: string[]) {
  return playerIds.length ? { id: { notIn: playerIds } } : {};
}

export function shouldRemoveFeeConfig(feeConfig: unknown) {
  return feeConfig === null;
}
