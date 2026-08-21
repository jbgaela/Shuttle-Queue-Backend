type DateTimeParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function formatParts(value: Date, timeZone: string): DateTimeParts {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(value);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return { year: values.year!, month: values.month!, day: values.day!, hour: values.hour!, minute: values.minute!, second: values.second! };
}

function parseLocalDateTime(value: string): DateTimeParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new RangeError("Invalid local date-time.");
  const result = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] ?? 0) };
  const candidate = new Date(Date.UTC(result.year, result.month - 1, result.day, result.hour, result.minute, result.second));
  if (candidate.getUTCFullYear() !== result.year || candidate.getUTCMonth() + 1 !== result.month || candidate.getUTCDate() !== result.day || candidate.getUTCHours() !== result.hour || candidate.getUTCMinutes() !== result.minute || candidate.getUTCSeconds() !== result.second) throw new RangeError("Invalid local date-time.");
  return result;
}

export function instantForLocalDateTime(value: string, timeZone: string): Date {
  const local = parseLocalDateTime(value);
  const desired = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = formatParts(new Date(candidate), timeZone);
    const offset = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second) - candidate;
    candidate = desired - offset;
  }
  const result = new Date(candidate);
  const actual = formatParts(result, timeZone);
  if (JSON.stringify(actual) !== JSON.stringify(local)) throw new RangeError("The local date-time does not exist in the account timezone.");
  return result;
}

export function datePartsForInstant(value: Date, timeZone: string) {
  const parts = formatParts(value, timeZone);
  return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

export function localDateTimeForInstant(value: Date, timeZone: string) {
  const parts = formatParts(value, timeZone);
  return `${datePartsForInstant(value, timeZone)}T${parts.hour.toString().padStart(2, "0")}:${parts.minute.toString().padStart(2, "0")}`;
}

export function inclusiveMinuteCutoff(value: string, timeZone: string) {
  return new Date(instantForLocalDateTime(value, timeZone).getTime() + 59_999);
}
