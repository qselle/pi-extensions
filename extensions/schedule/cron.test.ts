import { describe, expect, test } from "bun:test";
import { nextCronOccurrence, parseCron, validTimeZone, wallClockAt } from "./cron.ts";

describe("cron scheduling", () => {
  test("parses lists, ranges, steps, and English month/day names", () => {
    const spec = parseCron("*/15 9-17 * JAN,MAR MON-FRI");
    expect(spec?.minute).toEqual(new Set([0, 15, 30, 45]));
    expect(spec?.hour.has(17)).toBe(true);
    expect(spec?.month).toEqual(new Set([1, 3]));
    expect(spec?.dayOfWeek).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  test("rejects unsupported or out-of-range expressions", () => {
    expect(parseCron("* * * *")).toBeUndefined();
    expect(parseCron("60 * * * *")).toBeUndefined();
    expect(parseCron("* * * * FRI-MON")).toBeUndefined();
    expect(parseCron("@daily")).toBeUndefined();
  });

  test("finds timezone-aware future occurrences", () => {
    const after = Date.parse("2026-08-07T18:00:00Z");
    const next = nextCronOccurrence("0 9 * * MON-FRI", after, "Europe/Berlin");
    expect(new Date(next!).toISOString()).toBe("2026-08-10T07:00:00.000Z");
    expect(wallClockAt(next!, "Europe/Berlin")).toBe("2026-8-10T9:0");
  });

  test("treats stepped stars as wildcard day fields", () => {
    const after = Date.parse("2026-08-09T08:00:00Z");
    const next = nextCronOccurrence("0 9 */1 * MON", after, "UTC");
    expect(new Date(next!).toISOString()).toBe("2026-08-10T09:00:00.000Z");
  });

  test("finds leap-day occurrences beyond one year", () => {
    const after = Date.parse("2026-03-01T00:00:00Z");
    const next = nextCronOccurrence("0 0 29 2 *", after, "UTC");
    expect(new Date(next!).toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  test("does not skip valid times across half-hour DST transitions", () => {
    const after = Date.parse("2026-10-03T15:14:00Z");
    const next = nextCronOccurrence("45 2 * * *", after, "Australia/Lord_Howe");
    expect(new Date(next!).toISOString()).toBe("2026-10-03T15:45:00.000Z");
  });

  test("validates IANA zones", () => {
    expect(validTimeZone("Europe/Berlin")).toBe(true);
    expect(validTimeZone("Not/AZone")).toBe(false);
  });
});
