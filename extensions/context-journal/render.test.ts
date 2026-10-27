import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { boundaryDivider, boundaryLabel } from "./render.ts";

test("rollover divider names the cause, usage and staleness", () => {
  expect(boundaryLabel({ version: 1, reason: "automatic", percent: 91.24 })).toBe("Context reset — automatic at 91.2% — no summary");
  expect(boundaryLabel({ version: 1, reason: "agent" })).toBe("Context reset — requested by agent — no summary");
  expect(boundaryLabel({ version: 1, reason: "manual", stale: true })).toBe("Context reset — manual — stale notes — no summary");
  // Boundaries written before reasons were recorded still render.
  expect(boundaryLabel({ version: 1 } as any)).toBe("Context reset — no summary");
});

test("rollover divider fits every width with a single stable row", () => {
  const theme = { fg: (_color: string, text: string) => `\x1b[2m${text}\x1b[22m` } as any;
  const divider = boundaryDivider({ version: 1, reason: "automatic", percent: 91.2 }, theme);
  for (let width = 0; width <= 120; width++) {
    const lines = divider.render(width);
    expect(lines.length).toBe(width <= 2 ? 0 : 1);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width - 2);
    expect(divider.render(width)).toEqual(lines);
  }
  expect(visibleWidth(divider.render(80)[0]!)).toBe(78);
  expect(divider.render(80)[0]).toContain(" Context reset — automatic at 91.2% — no summary ");
});
