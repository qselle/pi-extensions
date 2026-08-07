const MONTH_NAMES = new Map([
  ["JAN", 1], ["FEB", 2], ["MAR", 3], ["APR", 4], ["MAY", 5], ["JUN", 6],
  ["JUL", 7], ["AUG", 8], ["SEP", 9], ["OCT", 10], ["NOV", 11], ["DEC", 12],
]);
const DAY_NAMES = new Map([["SUN", 0], ["MON", 1], ["TUE", 2], ["WED", 3], ["THU", 4], ["FRI", 5], ["SAT", 6]]);
const MAX_SEARCH_DAYS = 8 * 366;
const HOUR_MS = 60 * 60 * 1_000;

export interface CronSpec {
  expression: string;
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  dayOfMonthWildcard: boolean;
  dayOfWeekWildcard: boolean;
}

export function parseCron(expression: string): CronSpec | undefined {
  const parts = expression.trim().replace(/\s+/g, " ").split(" ");
  if (parts.length !== 5) return undefined;
  const minute = parseField(parts[0]!, 0, 59);
  const hour = parseField(parts[1]!, 0, 23);
  const dayOfMonth = parseField(parts[2]!, 1, 31);
  const month = parseField(parts[3]!, 1, 12, MONTH_NAMES);
  const dayOfWeek = parseField(parts[4]!, 0, 7, DAY_NAMES, true);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return undefined;
  return {
    expression: parts.join(" "), minute, hour, dayOfMonth, month, dayOfWeek,
    dayOfMonthWildcard: parts[2]!.includes("*"), dayOfWeekWildcard: parts[4]!.includes("*"),
  };
}

export function nextCronOccurrence(
  expression: string,
  afterMs: number,
  timeZone: string,
  excludedWallClock?: string,
): number | undefined {
  const spec = parseCron(expression);
  const formatter = cronFormatter(timeZone);
  if (!spec || !formatter || !Number.isFinite(afterMs)) return undefined;
  const minimum = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  const start = zonedParts(minimum, formatter);
  const day = new Date(Date.UTC(start.year, start.month - 1, start.day));
  const hours = [...spec.hour].sort((a, b) => a - b);
  const minutes = [...spec.minute].sort((a, b) => a - b);

  for (let checked = 0; checked < MAX_SEARCH_DAYS; checked++, day.setUTCDate(day.getUTCDate() + 1)) {
    const year = day.getUTCFullYear();
    const month = day.getUTCMonth() + 1;
    const date = day.getUTCDate();
    const weekday = day.getUTCDay();
    if (!matchesDate(spec, month, date, weekday)) continue;

    const wallDay = Date.UTC(year, month - 1, date, 12);
    const offsets = possibleOffsets(wallDay, formatter);
    let earliest: number | undefined;
    for (const hour of hours) {
      for (const minute of minutes) {
        const wallTime = Date.UTC(year, month - 1, date, hour, minute);
        for (const offset of offsets) {
          const candidate = wallTime - offset;
          if (candidate < minimum || (earliest !== undefined && candidate >= earliest)) continue;
          const parts = zonedParts(candidate, formatter);
          if (matches(spec, parts) && wallClockKey(parts) !== excludedWallClock) earliest = candidate;
        }
      }
    }
    if (earliest !== undefined) return earliest;
  }
  return undefined;
}

export function wallClockAt(timestamp: number, timeZone: string): string | undefined {
  const formatter = cronFormatter(timeZone);
  return formatter ? wallClockKey(zonedParts(timestamp, formatter)) : undefined;
}

export function validTimeZone(value: string): boolean {
  return Boolean(cronFormatter(value));
}

function parseField(
  input: string,
  minimum: number,
  maximum: number,
  names = new Map<string, number>(),
  normalizeSunday = false,
): Set<number> | undefined {
  if (!input) return undefined;
  const values = new Set<number>();
  for (const item of input.toUpperCase().split(",")) {
    if (!item) return undefined;
    const [base, stepText, extra] = item.split("/");
    if (extra !== undefined) return undefined;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || step > maximum - minimum + 1) return undefined;
    let start: number;
    let end: number;
    if (base === "*") {
      start = minimum; end = maximum;
    } else if (base!.includes("-")) {
      const range = base!.split("-");
      if (range.length !== 2) return undefined;
      start = parseValue(range[0]!, names);
      end = parseValue(range[1]!, names);
    } else {
      start = parseValue(base!, names);
      end = stepText === undefined ? start : maximum;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < minimum || end > maximum || start > end) return undefined;
    for (let value = start; value <= end; value += step) values.add(normalizeSunday && value === 7 ? 0 : value);
  }
  return values.size ? values : undefined;
}

function parseValue(value: string, names: Map<string, number>): number {
  return names.get(value) ?? Number(value);
}

interface ZonedParts { minute: number; hour: number; day: number; month: number; weekday: number; year: number }

function matches(spec: CronSpec, parts: ZonedParts): boolean {
  return spec.minute.has(parts.minute)
    && spec.hour.has(parts.hour)
    && matchesDate(spec, parts.month, parts.day, parts.weekday);
}

function matchesDate(spec: CronSpec, month: number, day: number, weekday: number): boolean {
  if (!spec.month.has(month)) return false;
  const dom = spec.dayOfMonth.has(day);
  const dow = spec.dayOfWeek.has(weekday);
  const dayMatches = spec.dayOfMonthWildcard || spec.dayOfWeekWildcard ? dom && dow : dom || dow;
  return dayMatches;
}

function possibleOffsets(wallDay: number, formatter: Intl.DateTimeFormat): number[] {
  const offsets = new Set<number>();
  for (let delta = -48 * HOUR_MS; delta <= 48 * HOUR_MS; delta += 6 * HOUR_MS) {
    const timestamp = wallDay + delta;
    const parts = zonedParts(timestamp, formatter);
    const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    offsets.add(representedAsUtc - timestamp);
  }
  return [...offsets];
}

function cronFormatter(timeZone: string): Intl.DateTimeFormat | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", weekday: "short",
    });
  } catch { return undefined; }
}

function zonedParts(timestamp: number, formatter: Intl.DateTimeFormat): ZonedParts {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  return {
    minute: Number(parts.minute), hour: Number(parts.hour), day: Number(parts.day), month: Number(parts.month),
    year: Number(parts.year), weekday: DAY_NAMES.get(parts.weekday!.toUpperCase())!,
  };
}

function wallClockKey(parts: ZonedParts): string {
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
