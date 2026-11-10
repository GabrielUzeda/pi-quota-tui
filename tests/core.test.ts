// Tests for the rules that decide what the user sees: pace, health, parsers and reset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bar } from "../src/format.ts";
import { health, pace, visible } from "../src/rules.ts";
import { agySnapshot, collapse, estimateReset, nextMonthlyReset, paidIndex, parseAgyAccounts, parseCodex } from "../src/providers.ts";
import type { Snapshot } from "../src/models.ts";

const NOW = 1_700_000_000;

test("pace: half of a 5h cycle with half used stays on pace", () => {
  const w = { label: "5 hours", used: 50, resetsAt: NOW + 9000, duration: 18000 };
  assert.equal(pace(w, NOW), 50);
  const s: Snapshot = { id: "x", name: "X", windows: [w], updatedAt: NOW, source: "" };
  assert.equal(health(s, NOW), "ON TRACK");
});

test("health: no windows is NO SIGNAL; a short balance for the cycle is LOW", () => {
  const empty: Snapshot = { id: "x", name: "X", windows: [], source: "" };
  assert.equal(health(empty, NOW), "NO SIGNAL");
  const hot: Snapshot = { id: "x", name: "X", windows: [{ label: "Weekly", used: 95 }], updatedAt: NOW, source: "" };
  assert.equal(health(hot, NOW), "LOW");
});

test("codex: 5h/weekly windows from the reported duration", () => {
  const snap = parseCodex({
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: NOW + 600 },
                                    secondary: { usedPercent: 70, windowDurationMins: 10080 } } },
  }, NOW);
  assert.deepEqual(snap.windows.map((w) => [w.label, w.duration]), [["5 hours", 18000], ["Weekly", 604800]]);
});

test("Antigravity: paid account chosen by the hint and the others become BONUS without summing", () => {
  const accounts = parseAgyAccounts([
    { email: "a@x", refreshToken: "r" },
    { email: "b@x", refreshToken: "r" },
  ]);
  const groups = (fraction: number) => [{ displayName: "Claude", buckets: [{ window: "5h", remainingFraction: fraction }] }];
  const snaps = [agySnapshot(accounts[0], 0, groups(0.5), NOW), agySnapshot(accounts[1], 1, groups(0.9), NOW)];
  assert.equal(paidIndex(accounts, snaps, "b@x"), 1);
  const merged = collapse(snaps, 1, NOW);
  assert.equal(merged.id, "antigravity");
  assert.match(merged.note ?? "", /^PAID /);
  assert.match(merged.note ?? "", /BONUS 1 accounts: 5 hours 50% free/);
});

test("reset: weekly is never invented; monthly becomes the next reset day", () => {
  assert.equal(estimateReset([{ at: NOW, fh: 10 }], "sd", 0, NOW, 604800)[0], undefined);
  const reset = nextMonthlyReset(16, Date.UTC(2024, 0, 20) / 1000);
  assert.equal(new Date(reset * 1000).toISOString(), "2024-02-16T00:00:00.000Z");
});

test("bar marks the pace", () => {
  assert.equal(bar(50, 50, 10), "█████│░░░░");
});

test("visible: an exhausted window hides the ones below (monthly > weekly > 5h)", () => {
  const names = (windows: { label: string; used: number }[]) => visible(windows.map((w) => ({ ...w }))).map((w) => w.label);
  const all = [{ label: "5 hours", used: 10 }, { label: "Weekly", used: 20 }, { label: "Monthly", used: 30 }];
  assert.deepEqual(names(all), ["5 hours", "Weekly", "Monthly"]);
  assert.deepEqual(names([{ ...all[0], used: 100 }, all[1], all[2]]), ["Weekly", "Monthly"]);
  assert.deepEqual(names([all[0], { ...all[1], used: 100 }, all[2]]), ["Monthly"]);
  assert.deepEqual(names([all[0], all[1], { ...all[2], used: 100 }]), []);
  // 99.96 counts too: the screen rounds to 0% left
  assert.deepEqual(names([all[0], all[1], { ...all[2], used: 99.96 }]), []);
  assert.deepEqual(names([all[0], all[1], { ...all[2], used: 99.4 }]), ["5 hours", "Weekly", "Monthly"]);
  // Unknown rank (AGY families) never vanishes nor exhausts the group
  const agy = [{ label: "5 hours", used: 100, group: "Gemini" }, { label: "5 hours", used: 5, group: "Claude" },
               { label: "Limit", used: 100, group: "Gemini" }];
  assert.deepEqual(visible(agy).map((w) => w.group + "/" + w.label), ["Claude/5 hours", "Gemini/Limit"]);
});
