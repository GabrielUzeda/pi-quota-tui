// Preferences: parsing, file round trip, the /quota-config menu and their effect on Monitor and panel.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { configPath, DEFAULTS, loadConfig, parseConfig, saveConfig } from "../src/config.ts";
import { editConfig, type MenuUI } from "../src/config-menu.ts";
import { QuotaPanel } from "../src/panel.ts";
import { Monitor } from "../src/service.ts";
import type { Snapshot } from "../src/models.ts";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
const NOW = Date.now() / 1000;

/** Answers select/input in order; a select answer that is a function picks from the offered options. */
function scripted(answers: (string | undefined | ((options: string[]) => string))[]): MenuUI & { errors: string[] } {
  const errors: string[] = [];
  const next = (options: string[] = []) => {
    assert.ok(answers.length, "menu asked more than the script answers");
    const answer = answers.shift();
    return typeof answer === "function" ? answer(options) : answer;
  };
  return {
    errors,
    select: async (_title, options) => next(options),
    input: async () => next(),
    notify: (message, type) => void (type === "error" && errors.push(message)),
  };
}
const starting = (prefix: string) => (options: string[]) => options.find((o) => o.startsWith(prefix)) ?? assert.fail(prefix);

test("parseConfig: empty, garbage and wrong types fall back to the defaults", () => {
  for (const raw of [undefined, null, 42, "x", [], {}]) assert.deepEqual(parseConfig(raw), DEFAULTS);
  assert.deepEqual(
    parseConfig({ hiddenProviders: "openai", refreshSeconds: "60", showOnStart: 1, placement: "left", barWidth: 8.5, columns: 3, showExpired: null }),
    DEFAULTS,
  );
});

test("parseConfig: keeps valid fields, drops unknown providers, duplicates and out-of-range numbers", () => {
  const c = parseConfig({ hiddenProviders: ["openai", "nope", "openai", 7], refreshSeconds: 29, barWidth: 30, columns: 1, placement: "aboveEditor", extra: true });
  assert.deepEqual(c.hiddenProviders, ["openai"]);
  assert.equal(c.refreshSeconds, DEFAULTS.refreshSeconds);
  assert.equal(c.barWidth, 30);
  assert.equal(c.columns, 1);
  assert.equal(c.placement, "aboveEditor");
  assert.equal("extra" in c, false);
});

test("loadConfig/saveConfig: missing is silent, invalid warns, saved file round-trips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pqt-config-"));
  const file = join(dir, "nested", "pi-quota-tui.json");
  try {
    assert.deepEqual(await loadConfig(file), { config: DEFAULTS });
    const custom = parseConfig({ hiddenProviders: ["claude"], refreshSeconds: 300, columns: 1 });
    await saveConfig(custom, file);
    assert.deepEqual((await loadConfig(file)).config, custom);
    assert.ok((await readFile(file, "utf8")).endsWith("\n"));
    await writeFile(file, "{ not json");
    const broken = await loadConfig(file);
    assert.deepEqual(broken.config, DEFAULTS);
    assert.match(broken.error ?? "", /Invalid JSON/);
    // A BOM (Windows editors) is not an error.
    await writeFile(file, "\uFEFF" + JSON.stringify({ barWidth: 12 }));
    assert.equal((await loadConfig(file)).config.barWidth, 12);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveConfig: keeps keys it does not know and copies a broken file to .bak", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pqt-config-"));
  const file = join(dir, "pi-quota-tui.json");
  try {
    await writeFile(file, JSON.stringify({ futureOption: { a: 1 }, barWidth: 99 }));
    await saveConfig(parseConfig({ barWidth: 10 }), file);
    const merged = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(merged.futureOption, { a: 1 });
    assert.equal(merged.barWidth, 10);

    await writeFile(file, "{ broken by hand");
    await saveConfig(DEFAULTS, file);
    assert.equal(await readFile(file + ".bak", "utf8"), "{ broken by hand");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { ...DEFAULTS });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("configPath follows PI_CODING_AGENT_DIR, like pi itself", () => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = "/tmp/custom-agent";
    assert.equal(configPath(), "/tmp/custom-agent/pi-quota-tui.json");
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  }
});

test("Monitor: the timer fires every refreshSeconds and a new interval restarts it", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const monitor = new Monitor({ a: async () => (calls++, []) });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    monitor.configure({ refreshSeconds: 30, hiddenProviders: [] });
    monitor.start();
    await settle();
    assert.equal(calls, 1);
    mock.timers.tick(29_999);
    assert.equal(calls, 1);
    mock.timers.tick(1);
    await settle();
    assert.equal(calls, 2);
    // Restarting on configure also reads once right away.
    monitor.configure({ refreshSeconds: 60, hiddenProviders: [] });
    await settle();
    assert.equal(calls, 3);
    mock.timers.tick(30_000);
    assert.equal(calls, 3);
    mock.timers.tick(30_000);
    await settle();
    assert.equal(calls, 4);
    monitor.stop();
    mock.timers.tick(120_000);
    assert.equal(calls, 4);
  } finally {
    monitor.stop();
    mock.timers.reset();
  }
});

test("Monitor: a provider brought back mid-read is collected when the read lands", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const collected: string[] = [];
  const monitor = new Monitor({
    a: async () => {
      await gate;
      return [{ id: "a", name: "a", windows: [{ label: "5 hours", used: 1 }], source: "test" }];
    },
    b: async () => {
      collected.push("b");
      return [{ id: "b", name: "b", windows: [{ label: "5 hours", used: 2 }], source: "test" }];
    },
  });
  try {
    monitor.configure({ refreshSeconds: 120, hiddenProviders: ["b"] });
    monitor.start();
    // /quota-config unhides b while the first read is still running.
    monitor.configure({ refreshSeconds: 120, hiddenProviders: [] });
    assert.deepEqual(collected, []);
    release();
    await monitor.refresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(collected, ["b"]);
    assert.ok(monitor.snapshots("b").some((s) => s.windows.length));
  } finally {
    monitor.stop();
  }
});

test("Monitor: onUpdate fires when a read lands and not for a hidden provider", async () => {
  let updates = 0;
  const monitor = new Monitor({ a: async () => [] });
  monitor.onUpdate = () => updates++;
  monitor.configure({ refreshSeconds: 120, hiddenProviders: ["a"] });
  await monitor.refresh();
  assert.equal(updates, 0);
  monitor.configure({ refreshSeconds: 120, hiddenProviders: [] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(updates, 1);
});

test("editConfig: toggles, numbers and providers apply only on Save, without mutating the input", async () => {
  const start = parseConfig({});
  const ui = scripted([
    starting("Providers:"), starting("[x] OpenAI"), starting("[x] Claude"), starting("[ ] Claude"), "Done",
    starting("Refresh every:"), "300",
    starting("Bar width:"), "99", // out of range: warns and keeps 8
    starting("Bar width:"), "", // empty keeps the value
    starting("Panel position:"), starting("Providers per row:"), starting("Expired row:"), starting("Panel on start:"),
    "Save",
  ]);
  const edited = await editConfig(ui, start);
  assert.deepEqual(edited, {
    hiddenProviders: ["openai"], refreshSeconds: 300, showOnStart: false, placement: "aboveEditor",
    barWidth: 8, columns: 1, showExpired: false,
  });
  assert.equal(ui.errors.length, 1);
  assert.deepEqual(start, DEFAULTS);
});

test("editConfig: Esc cancels and Reset restores the defaults", async () => {
  const custom = parseConfig({ hiddenProviders: ["openai"], barWidth: 20 });
  assert.equal(await editConfig(scripted([starting("Bar width:"), "10", undefined]), custom), undefined);
  assert.deepEqual(await editConfig(scripted([starting("Reset"), "Save"]), custom), DEFAULTS);
});

test("Monitor: hidden providers are neither collected nor listed, and come back when unhidden", async () => {
  const calls: string[] = [];
  const collector = (id: string) => async (): Promise<Snapshot[]> => {
    calls.push(id);
    return [{ id, name: id, windows: [{ label: "5 hours", used: 10 }], updatedAt: NOW, source: "t" }];
  };
  const monitor = new Monitor({ a: collector("a"), b: collector("b") });
  monitor.configure({ refreshSeconds: 60, hiddenProviders: ["b"] });
  await monitor.refresh();
  assert.deepEqual(calls, ["a"]);
  assert.deepEqual(monitor.snapshots().map((s) => s.id), ["a"]);
  assert.deepEqual(monitor.snapshots("b"), []);
  monitor.configure({ refreshSeconds: 60, hiddenProviders: [] });
  await monitor.refresh();
  assert.deepEqual(monitor.snapshots().map((s) => s.id).sort(), ["a", "b"]);
  monitor.stop();
});

test("panel: barWidth, columns and showExpired change the drawing and never overflow", () => {
  const monitor = new Monitor({});
  const data = (monitor as unknown as { data: Map<string, Snapshot[]> }).data;
  const snap = (id: string, used: number): Snapshot =>
    ({ id, name: id, windows: [{ label: "Weekly", used, resetsAt: NOW + 3600, duration: 604800 }], updatedAt: NOW, source: "t" });
  data.set("x", [snap("x", 10)]);
  data.set("y", [snap("y", 20)]);
  data.set("z", [snap("z", 100)]);
  const render = (options: Partial<typeof DEFAULTS>, width = 100) =>
    new QuotaPanel(monitor, theme, { ...DEFAULTS, ...options }).render(width);

  assert.equal(render({}).length, 2); // x and y share a row, then Expired
  assert.equal(render({ columns: 1 }).length, 3);
  assert.ok(render({}).some((l) => l.includes("Expired:")));
  assert.ok(!render({ showExpired: false }).some((l) => l.includes("Expired:")));
  const barOf = (line: string) => line.match(/[█░│]+/)?.[0].length;
  assert.equal(barOf(render({ barWidth: 20, columns: 1 })[0]), 20);
  for (const width of [20, 46, 80])
    for (const line of render({ barWidth: 30, columns: 2 }, width)) assert.ok(visibleWidth(line) <= width, line);
});
