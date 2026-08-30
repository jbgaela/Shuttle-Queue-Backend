export function slidingIdleExpiry(now: Date, absoluteExpiresAt: Date, idleMinutes: number) {
  return new Date(Math.min(now.getTime() + idleMinutes * 60_000, absoluteExpiresAt.getTime()));
}
