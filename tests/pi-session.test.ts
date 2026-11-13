// Cross-cutting with pi itself: the extension runs inside a real AgentSession (SDK), not a fake pi.
// No model is called: slash commands run in the extension runner. Sandboxed agent dir, no keys, empty PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import factory from "../src/index.ts";

const ENV = ["HOME", "PI_CODING_AGENT_DIR", "PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_GO_KEY",
  "COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY", "PI_QUOTA_TUI_AGY_ACCOUNTS"];

test("pi session: loads the extension, mounts the panel from the config and runs /quota and /quota-config", async () => {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const home = await mkdtemp(join(tmpdir(), "pqt-pi-"));
  const agentDir = join(home, "agent");
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agentDir, PATH: join(home, "bin"),
    XDG_CONFIG_HOME: join(home, "c"), XDG_DATA_HOME: join(home, "d") });

  const widgets: { key: string; content: unknown; placement?: string }[] = [];
  const notes: string[] = [];
  const errors: unknown[] = [];
  const answers = ["Bar width:", "14", "Save"];
  const ui = {
    setWidget: (key: string, content: unknown, options?: { placement?: string }) => widgets.push({ key, content, placement: options?.placement }),
    notify: (message: string) => notes.push(message),
    select: async (_title: string, options: string[]) => {
      // An empty script is Esc, so a wrong label fails the test instead of looping the menu.
      const want = answers.shift();
      return want === undefined ? undefined : options.find((o) => o.startsWith(want));
    },
    input: async () => answers.shift(),
  };
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const file = join(agentDir, "pi-quota-tui.json");
    await mkdir(agentDir, { recursive: true });
    await writeFile(file, JSON.stringify({ placement: "aboveEditor", hiddenProviders: ["openai"], myNote: "kept" }));

    const resourceLoader = new DefaultResourceLoader({
      cwd: home, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [factory],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: home, agentDir, resourceLoader, sessionManager: SessionManager.inMemory() }));
    assert.ok(session.getAllTools().some((tool) => tool.name === "get_quotas"));

    await session.bindExtensions({ uiContext: ui as never, mode: "tui", onError: (error: unknown) => errors.push(error) } as never);
    assert.equal(widgets.length, 1);
    assert.equal(widgets[0].placement, "aboveEditor");

    await session.prompt("/quota");
    const reports = session.sessionManager.getEntries()
      .filter((e) => e.type === "custom" && e.customType === "quota-report") as unknown as { data: { content: string } }[];
    assert.equal(reports.length, 1);
    assert.match(reports[0].data.content, /Not configured: .*OpenCode Go/);
    assert.doesNotMatch(reports[0].data.content, /OpenAI/);
    // A report is not a message: nothing went to the model.
    assert.equal(session.messages.length, 0);

    await session.prompt("/quota-config");
    const written = JSON.parse(await readFile(file, "utf8"));
    assert.equal(written.barWidth, 14);
    assert.equal(written.myNote, "kept");
    assert.equal(widgets.at(-1)!.placement, "aboveEditor");
    assert.ok(notes.some((n) => n === "Saved to " + file + "."));
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(home, { recursive: true, force: true });
  }
});
