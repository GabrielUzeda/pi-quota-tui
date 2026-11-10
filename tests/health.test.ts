import { test } from "node:test";
import assert from "node:assert/strict";
import { health } from "../src/rules.ts";
import { parseCodex } from "../src/providers.ts";
const NOW = 1_700_000_000;
const DAY = 86400;
function quota(left: number, days: number) {
  return parseCodex({ rateLimits: { secondary: {
    usedPercent: 100 - left, windowDurationMins: 10080, resetsAt: NOW + days * DAY,
  } } }, NOW);
}
test("health compares the weekly balance with the time left", () => {
  for (const [left, days, status] of [
    [75, 3, "SLACK"], [55, 3.5, "ON TRACK"],
    [83, 5, "ON TRACK"], [83, 4, "SLACK"],
    [45, 3.5, "TIGHT"], [30, 3.5, "LOW"],
    [5, 0.1, "SLACK"], [0, 0.1, "LOW"],
  ] as const) assert.equal(health(quota(left, days), NOW), status, left + "/" + days);
});
test("the tightest window prevails, no summing nor averaging", () => {
  const s = quota(75, 3);
  s.windows.push({ label: "5 hours", used: 95, resetsAt: NOW + 9000, duration: 18000 });
  assert.equal(health(s, NOW), "LOW");
});
test("without duration or reset it uses only the balance, without inventing time", () => {
  const s = quota(83, 4);
  delete s.windows[0].duration;
  assert.equal(health(s, NOW), "SLACK");
  s.windows[0].used = 95;
  assert.equal(health(s, NOW), "LOW");
});
