export function activePublicRankingWhere() {
  return {
    enabled: true,
    OR: [{ revokedAt: null }, { revokedAt: { isSet: false } }],
  };
}
