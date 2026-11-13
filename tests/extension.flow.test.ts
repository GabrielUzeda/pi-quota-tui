// Cross-cutting: the real extension factory, from the JSON on disk to the panel, /quota and /quota-config.
// Sandboxed HOME, no keys and an empty PATH: every collector stays offline and reports "not configured".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import factory from "../src/index.ts";

const ENV = ["HOME", "PI_CODING_AGENT_DIR", "PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_GO_KEY", "COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY", "PI_QUOTA_TUI_AGY_ACCOUNTS"];
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
type Handler = (...args: unknown[]) => Promise<unknown> | unknown;

test("flow: config file drives the panel, hides providers in /quota and /quota-config saves and re-mounts", async () => {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const home = await mkdtemp(join(tmpdir(), "pqt-flow-"));
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { HOME: home, PATH: join(home, "bin"), XDG_CONFIG_HOME: join(home, "c"), XDG_DATA_HOME: join(home, "d") });

  const commands = new Map<string, Handler>();
  const events = new Map<string, Handler>();
  const entries: { content: string }[] = [];
  const pi = {
    registerCommand: (name: string, c: { handler: Handler }) => commands.set(name, c.handler),
    registerTool: () => {},
    registerEntryRenderer: () => {},
    appendEntry: (_type: string, data: { content: string }) => entries.push(data),
    on: (event: string, handler: Handler) => events.set(event, handler),
  };
  const widgets: { content: unknown; placement?: string }[] = [];
  const notes: string[] = [];
  const answers: (string | undefined)[] = [];
  const ctx = {
    hasUI: true,
    modelRegistry: { getProviderAuth: async () => undefined },
    ui: {
      setWidget: (_key: string, content: unknown, options?: { placement?: string }) => widgets.push({ content, placement: options?.placement }),
      notify: (message: string) => notes.push(message),
      select: async (_title: string, options: string[]) => {
        const want = answers.shift();
        return want === undefined ? undefined : options.find((o) => o.startsWith(want)) ?? assert.fail("no option " + want);
      },
      input: async () => answers.shift(),
    },
  };

  try {
    const file = join(home, ".pi", "agent", "pi-quota-tui.json");
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(file, JSON.stringify({ hiddenProviders: ["commandcode"], placement: "aboveEditor", barWidth: 12 }));
    factory(pi as never);

    await events.get("session_start")!({}, ctx);
    assert.equal(widgets.length, 1);
    assert.equal(widgets[0].placement, "aboveEditor");
    let redraws = 0;
    const panel = (widgets[0].content as (tui: unknown, t: unknown) => { render(w: number): string[] })(
      { requestRender: () => redraws++ }, theme);
    for (const line of panel.render(40)) assert.ok(visibleWidth(line) <= 40);

    await commands.get("quota")!("", ctx);
    const text = entries.at(-1)!.content;
    // A read that lands asks pi for a redraw: the panel would otherwise wait for the next keypress.
    assert.ok(redraws > 0);
    assert.match(text, /Not configured: .*OpenCode Go/);
    assert.doesNotMatch(text, /CommandCode/);

    answers.push("Panel position:", "Providers:", "[ ] CommandCode", "Done", "Save");
    await commands.get("quota-config")!("", ctx);
    const written = JSON.parse(await readFile(file, "utf8"));
    assert.equal(written.placement, "belowEditor");
    assert.deepEqual(written.hiddenProviders, []);
    assert.equal(written.barWidth, 12);
    assert.equal(widgets.at(-1)!.placement, "belowEditor");
    assert.ok(notes.some((n) => n.startsWith("Saved to")));

    // Esc leaves the file untouched.
    answers.push("Bar width:", "20", undefined);
    await commands.get("quota-config")!("", ctx);
    assert.equal(JSON.parse(await readFile(file, "utf8")).barWidth, 12);

    await events.get("session_shutdown")!({}, ctx);
    assert.equal(widgets.at(-1)!.content, undefined);
  } finally {
    await events.get("session_shutdown")?.({}, ctx);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("flow: showOnStart false keeps the panel unmounted until /quotas", async () => {
  const savedHome = process.env.HOME;
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  const home = await mkdtemp(join(tmpdir(), "pqt-flow-"));
  process.env.HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
  const events = new Map<string, Handler>();
  const commands = new Map<string, Handler>();
  const widgets: unknown[] = [];
  const pi = {
    registerCommand: (name: string, c: { handler: Handler }) => commands.set(name, c.handler),
    registerTool: () => {}, registerEntryRenderer: () => {}, appendEntry: () => {},
    on: (event: string, handler: Handler) => events.set(event, handler),
  };
  const ctx = { hasUI: true, modelRegistry: { getProviderAuth: async () => undefined },
    ui: { setWidget: (_k: string, content: unknown) => widgets.push(content), notify: () => {} } };
  try {
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    // Every provider hidden: nothing is collected, so no network or subprocess even without the sandbox.
    await writeFile(join(home, ".pi", "agent", "pi-quota-tui.json"),
      JSON.stringify({ showOnStart: false, hiddenProviders: ["antigravity", "opencode", "openai", "claude", "commandcode"] }));
    factory(pi as never);
    await events.get("session_start")!({}, ctx);
    assert.equal(widgets.length, 0);
    await commands.get("quotas")!("", ctx);
    assert.equal(typeof widgets[0], "function");
  } finally {
    await events.get("session_shutdown")?.({}, ctx);
    process.env.HOME = savedHome;
    if (savedDir !== undefined) process.env.PI_CODING_AGENT_DIR = savedDir;
    await rm(home, { recursive: true, force: true });
  }
});
