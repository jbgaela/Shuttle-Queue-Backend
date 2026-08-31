/**
 * Parse the integer workspace versions used by the optimistic-locking API.
 *
 * Older clients sent a bare number while standards-compliant clients send an
 * entity-tag such as `"42"`. Keep accepting both during the rollout.
 */
export function parseIfMatchVersion(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const match = /^(?:([0-9]+)|"([0-9]+)")$/.exec(trimmed);
  if (!match) return undefined;
  const parsed = Number(match[1] ?? match[2]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseBodyVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

export function resolvePublishVersion(headerValue: string | undefined, bodyValue: unknown) {
  const headerPresent = headerValue !== undefined;
  const bodyPresent = bodyValue !== undefined;
  const headerVersion = parseIfMatchVersion(headerValue);
  const bodyVersion = parseBodyVersion(bodyValue);
  return {
    headerPresent,
    bodyPresent,
    mismatch: headerVersion !== undefined && bodyVersion !== undefined && headerVersion !== bodyVersion,
    version: headerPresent && headerVersion === undefined ? undefined : headerVersion ?? bodyVersion,
  };
}
