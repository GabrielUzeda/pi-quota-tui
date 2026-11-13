// List panel: up to two providers per line, windows separated by │ and wrapped with an indent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getCapabilities, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { barColor, QuotaPanel, waitColor } from "../src/panel.ts";
import { Monitor } from "../src/service.ts";
import type { Snapshot } from "../src/models.ts";

// A CI runner has no TERM/COLORTERM, so detection falls back to 256 colors: pin truecolor here or the
// escape assertions below would only hold on a machine with a color-capable terminal.
setCapabilities({ ...getCapabilities(), trueColor: true });

const NOW = Date.now() / 1000;
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "").trimEnd();

function panelWith(...snapshots: Snapshot[]) {
  const monitor = new Monitor();
  for (const s of snapshots) {
    (monitor as unknown as { data: Map<string, Snapshot[]> }).data.set(s.id, [s]);
  }
  return { panel: new QuotaPanel(monitor, theme), monitor };
}

const opencode: Snapshot = { id: "opencode", name: "OpenCode Go",
  windows: [{ label: "Weekly", used: 62, resetsAt: NOW + 3600, duration: 604800 }], updatedAt: NOW, source: "x" };

const openai: Snapshot = { id: "openai", name: "OpenAI Codex",
  windows: [{ label: "5 hours", used: 8, resetsAt: NOW + 10000, duration: 18000 }], updatedAt: NOW, source: "x" };

test("list: no separator between the provider name and the first window", () => {
  const { panel, monitor } = panelWith(opencode);
  try {
    const [line] = panel.render(60);
    assert.match(plain(line), /^OpenCode Go [█│]/);
    // Balance bar: only blocks and the pace mark, no percentage
    assert.match(line, /[█│]+░/);
    assert.doesNotMatch(plain(line), /\d+%/);
    assert.match(plain(line), /\d+(\.\d)?[hdm]/);
  } finally {
    monitor.stop();
  }
});

test("list: two providers per line when they fit, one per line when not", () => {
  const wide = panelWith(opencode, openai);
  try {
    const lines = wide.panel.render(120);
    assert.equal(lines.length, 1, "120 columns fit two providers");
    assert.match(plain(lines[0]), /^OpenCode Go .*OpenAI Codex /);
  } finally {
    wide.monitor.stop();
  }
  const narrow = panelWith(opencode, openai);
  try {
    const lines = narrow.panel.render(50);
    assert.equal(lines.length, 2);
    assert.match(plain(lines[0]), /^OpenCode Go /);
    assert.match(plain(lines[1]), /^OpenAI Codex /);
  } finally {
    narrow.monitor.stop();
  }
});

test("list: windows that do not fit wrap with an indent aligned under the first window", () => {
  const snapshot: Snapshot = {
    id: "antigravity", name: "Antigravity", updatedAt: NOW, source: "x",
    windows: [
      { label: "Weekly", used: 0.79, resetsAt: NOW + 6 * 86400, duration: 604800, group: "Gemini" },
      { label: "5 hours", used: 0, resetsAt: NOW + 6 * 3600, duration: 18000, group: "Gemini" },
      { label: "Weekly", used: 100, resetsAt: NOW + 2 * 86400, duration: 604800, group: "Claude" },
      { label: "Weekly", used: 98.46, resetsAt: NOW + 2 * 86400, duration: 604800, group: "Argon" },
    ],
  };
  const { panel, monitor } = panelWith(snapshot);
  try {
    const lines = panel.render(40);
    assert.ok(lines.length > 1, "must wrap into more than one line");
    assert.match(plain(lines[0]), /^Antigravity Gemini /);
    assert.ok(plain(lines[1]).startsWith(" ".repeat(12)), "indent = width of \"Antigravity \"");
    const text = plain(lines.join("\n"));
    // Claude has the Weekly exhausted: its windows leave the list, but come back in the Expired line.
    for (const family of ["Gemini", "Argon"]) assert.ok(text.includes(family), family);
    const [last] = lines.slice(-1);
    assert.match(plain(last), /^Expired: Antigravity Claude 2d$/, plain(last));
    for (const l of lines) assert.ok(visibleWidth(l) <= 40);
  } finally {
    monitor.stop();
  }
});

test("list: every window shows up, no cut (Argon is the 5th of AGY)", () => {
  const snapshot: Snapshot = {
    id: "antigravity", name: "Antigravity", updatedAt: NOW, source: "x",
    windows: [
      { label: "Weekly", used: 51, resetsAt: NOW + 3 * 86400, duration: 604800, group: "Gemini" },
      { label: "5 hours", used: 4, resetsAt: NOW + 3 * 3600, duration: 18000, group: "Gemini" },
      { label: "Weekly", used: 10, resetsAt: NOW + 7 * 86400, duration: 604800, group: "Claude" },
      { label: "5 hours", used: 20, resetsAt: NOW + 3 * 3600, duration: 18000, group: "Claude" },
      { label: "Weekly", used: 0, resetsAt: NOW + 7 * 86400, duration: 604800, group: "Argon" },
    ],
  };
  const { panel, monitor } = panelWith(snapshot);
  try {
    const text = plain(panel.render(60).join("\n"));
    assert.match(text, /Argon [█│]/, text);
  } finally {
    monitor.stop();
  }
});

test("list: Expired groups what is exhausted, from the soonest return to the latest", () => {
  const weekly: Snapshot = { id: "claude", name: "Claude Code", updatedAt: NOW, source: "x",
    windows: [{ label: "Weekly", used: 100, resetsAt: NOW + 4 * 86400, duration: 604800 }] };
  const monthly: Snapshot = { id: "outro", name: "Other", updatedAt: NOW, source: "x",
    windows: [{ label: "Monthly", used: 100, resetsAt: NOW + 7200 }, { label: "Weekly", used: 20, resetsAt: NOW + 7200 }] };
  const { panel, monitor } = panelWith(opencode, weekly, monthly);
  try {
    const lines = panel.render(60).map(plain);
    // Order = whoever comes back first; what is exhausted leaves the grid but stays in the final line.
    assert.equal(lines.at(-1), "Expired: Other 2h │ Claude Code 4d", lines.join("\n"));
    assert.match(lines[0], /^OpenCode Go /);
    assert.doesNotMatch(lines.slice(0, -1).join("\n"), /Other|Claude Code/, "only the exhausted one leaves the grid");
  } finally {
    monitor.stop();
  }
});

test("list: Expired in red, time by the cycle ramp (green = back soon)", () => {
  // 18h of a weekly and 1.2d of a weekly: green. 12.2d of a 30d monthly: red.
  const rgb = (duration: number | undefined, left: number | undefined) => {
    const c = waitColor(duration, left) as { r: number; g: number; b: number };
    return [c.r, c.g, c.b];
  };
  const [r1, g1] = rgb(604800, 18 * 3600);
  assert.ok(g1 > r1, "18h/7d green: " + [r1, g1]);
  const [r2, g2] = rgb(604800, 1.2 * 86400);
  assert.ok(g2 > r2, "1.2d/7d still green: " + [r2, g2]);
  const [r3, g3] = rgb(30 * 86400, 12.2 * 86400);
  assert.ok(r3 > g3, "12.2d/30d red: " + [r3, g3]);
  // Without a known cycle, the scale falls back to 1h..1d
  const [r4, g4] = rgb(undefined, 1800);
  assert.ok(g4 > r4, "30min without a cycle is green");
  const [r5, g5] = rgb(undefined, 2 * 86400);
  assert.ok(r5 > g5, "2d without a cycle is red");
  assert.equal(waitColor(604800, undefined), "dim");
  // The ramp is continuous: no jumps between marks
  assert.notDeepEqual(rgb(604800, 3 * 86400), rgb(604800, 3.5 * 86400));
});

test("list: color race of the Expired line keeps the brand name and the red tag", () => {
  const marked = { fg: (c: string, t: string) => `[${c}]${t}`, bold: (t: string) => t } as never;
  const far: Snapshot = { id: "outro", name: "Other", updatedAt: NOW, source: "x",
    windows: [{ label: "Weekly", used: 100, resetsAt: NOW + 4 * 86400, duration: 604800 }] };
  const monitor = new Monitor();
  (monitor as unknown as { data: Map<string, Snapshot[]> }).data.set(far.id, [far]);
  try {
    const line = new QuotaPanel(monitor, marked).render(80)[0];
    assert.match(line, /^\u001b\[38;2;255;69;58mExpired:\u001b\[39m /);
    // name comes from paintName (brand/default), the wait is an ANSI truecolor escape
    assert.match(line, /Other \u001b\[38;2;\d+;\d+;\d+m4d/);
  } finally {
    monitor.stop();
  }
});

test("list: a provider with only exhausted quotas still shows up in the Expired line", () => {
  const dead: Snapshot = { id: "opencode", name: "OpenCode Go", updatedAt: NOW, source: "x",
    windows: [{ label: "Weekly", used: 100, resetsAt: NOW + 1800, duration: 604800 }] };
  const { panel, monitor } = panelWith(dead);
  try {
    assert.match(plain(panel.render(60).at(-1)!), /^Expired: OpenCode Go 3\dm$/);
  } finally {
    monitor.stop();
  }
});

test("list: no state warning is written to the panel", () => {
  const stale: Snapshot = { ...opencode, updatedAt: NOW - 600 };
  const broken: Snapshot = { ...openai, windows: [], error: "Source unavailable." };
  const { panel, monitor } = panelWith(stale, broken);
  try {
    const text = plain(panel.render(120).join("\n"));
    for (const word of ["OUTDATED", "LOW", "TIGHT", "COOLDOWN", "NO SIGNAL", "SLACK"]) {
      assert.ok(!text.includes(word), word);
    }
  } finally {
    monitor.stop();
  }
});

test("list: brand colors per provider and no image sequences", () => {
  const { panel, monitor } = panelWith(opencode, openai);
  try {
    const lines = panel.render(120);
    assert.ok(lines.every((l) => !l.includes("\x1b_G")), "nothing from the Kitty protocol");
    // OpenAI (green) gets an ANSI color; OpenCode is white = the theme default text color
    assert.match(lines[0], /\x1b\[38;2;16;163;127m\x1b\[1mOpenAI Codex/);
    assert.ok(!lines[0].includes("\x1b[38;2;66"));
  } finally {
    monitor.stop();
  }
});

test("list: a provider with no window takes no line nor vanishes from /quota", () => {
  const noData: Snapshot = { id: "antigravity", name: "Antigravity", windows: [], source: "x",
    error: "Start the AGY proxy to read the Antigravity quotas." };
  const { panel, monitor } = panelWith(opencode, noData);
  try {
    const text = plain(panel.render(120).join("\n"));
    assert.match(text, /OpenCode Go /);
    assert.doesNotMatch(text, /Antigravity/);
  } finally {
    monitor.stop();
  }
});

test("bar color shows the pace: slack green, ahead yellow, burning red", () => {
  const w = (used: number) => ({ label: "x", used });
  assert.equal(barColor(w(20), 20), "success");
  assert.equal(barColor(w(15), 40), "success");
  assert.equal(barColor(w(50), 40), "warning");
  assert.equal(barColor(w(80), 40), "error");
  // Without pace (reset/duration unknown), it falls back to the absolute balance
  assert.equal(barColor(w(10), undefined), "accent");
  assert.equal(barColor(w(80), undefined), "warning");
  assert.equal(barColor(w(95), undefined), "error");
});
