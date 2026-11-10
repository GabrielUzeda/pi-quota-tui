// Query errors: every failure becomes a safe message (no URL, body or stack) and the provider stays listed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLLECTORS, ReadError, readJson } from "../src/providers.ts";
import { Monitor } from "../src/service.ts";
import type { Snapshot } from "../src/models.ts";
import { report } from "../src/format.ts";

let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    const route = req.url ?? "";
    if (route === "/500") {
      res.statusCode = 500;
      res.end("secret-in-body");
    } else if (route === "/401") {
      res.statusCode = 401;
      res.end("{}");
    } else if (route === "/redirect") {
      res.statusCode = 302;
      res.setHeader("location", "/html");
      res.end();
    } else if (route === "/html") {
      res.end("<html>");
    } else if (route === "/array") {
      res.end("[1]");
    } else if (route === "/slow") {
      setTimeout(() => res.end("{}"), 1500);
    } else if (route === "/big") {
      res.end('{"a":"' + "x".repeat(2 * 1024 * 1024 + 10) + '"}');
    } else {
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

async function errorOf(promise: Promise<unknown>): Promise<ReadError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ReadError, "error must be a ReadError: " + String(error));
    return error;
  }
  assert.fail("expected a failure");
}

/** Isolated environment: HOME and XDG in a temp folder, no real keys and no Codex on PATH. */
async function isolated(extra: Record<string, string | undefined>, fn: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "nt-home-"));
  const vars: Record<string, string | undefined> = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    OPENCODE_GO_KEY: undefined,
    COMMAND_CODE_API_KEY: undefined,
    COMMANDCODE_API_KEY: undefined,
    PI_QUOTA_TUI_AGY_PAID: undefined,
    ...extra,
  };
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn(home);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(home, { recursive: true, force: true });
  }
}

// --- readJson: transport and validation ---

test("connection refused becomes an unavailable message", async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", () => resolve()));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const error = await errorOf(readJson("http://127.0.0.1:" + port + "/x", { timeout: 2 }));
  assert.equal(error.message, "Source unavailable or the query timed out.");
});

test("HTTP 500 does not leak the response body", async () => {
  const error = await errorOf(readJson(base + "/500", { timeout: 2 }));
  assert.equal(error.message, "Query refused (HTTP 500).");
  assert.ok(!error.message.includes("secret"));
});

test("HTTP 401 and redirects are refused without following", async () => {
  assert.equal((await errorOf(readJson(base + "/401", { timeout: 2 }))).message, "Query refused (HTTP 401).");
  assert.equal((await errorOf(readJson(base + "/redirect", { timeout: 2 }))).message, "Query refused (HTTP 302).");
});

test("invalid JSON and unexpected format", async () => {
  assert.equal((await errorOf(readJson(base + "/html", { timeout: 2 }))).message, "Invalid quota response.");
  assert.equal((await errorOf(readJson(base + "/array", { timeout: 2 }))).message, "Unrecognized quota format.");
});

test("timeout becomes an unavailable message", async () => {
  const error = await errorOf(readJson(base + "/slow", { timeout: 0.2 }));
  assert.equal(error.message, "Source unavailable or the query timed out.");
});

test("a response above 2 MiB is cut during the read", async () => {
  const error = await errorOf(readJson(base + "/big", { timeout: 5 }));
  assert.equal(error.message, "Response exceeds the read limit.");
});

test("a disallowed URL is refused before any connection", async () => {
  for (const url of ["not a url", "ftp://127.0.0.1/x", "http://user:pw@127.0.0.1/x"]) {
    assert.equal((await errorOf(readJson(url, { timeout: 1 }))).message, "Quota address not allowed.");
  }
  assert.equal(
    (await errorOf(readJson("http://example.com/x", { timeout: 1 }))).message,
    "Plain HTTP allowed only on loopback.",
  );
});

// --- Monitor: what reaches the report ---

const NOW = Date.now() / 1000;
const okSnapshot: Snapshot = {
  id: "opencode", name: "OpenCode Go",
  windows: [{ label: "5 horas", used: 30 }], updatedAt: NOW, source: "x",
};
const offSnapshot = (id: string): Snapshot => ({ id, name: id, windows: [], source: "x", disabled: true });

/** Monitor where only OpenCode is controlled; the other providers stay disabled. */
function monitorWith(opencode: () => Promise<Snapshot[]>): Monitor {
  const collectors: Record<string, () => Promise<Snapshot[]>> = {};
  for (const id of Object.keys(COLLECTORS)) collectors[id] = async () => [offSnapshot(id)];
  collectors.opencode = opencode;
  return new Monitor(collectors);
}

test("a query error reaches the report with the specific message", async () => {
  const monitor = monitorWith(async () => {
    throw new ReadError("Query refused (HTTP 401).");
  });
  await monitor.refresh();
  const [s] = monitor.snapshots("opencode");
  assert.equal(s.error, "Query refused (HTTP 401).");
  assert.equal(s.disabled, false);
  monitor.stop();
});

test("an unexpected error does not leak internal details", async () => {
  const monitor = monitorWith(async () => {
    throw new TypeError("internal boom");
  });
  await monitor.refresh();
  const [s] = monitor.snapshots("opencode");
  assert.equal(s.error, "Internal read failure; last quota kept.");
  assert.ok(!(s.error ?? "").includes("boom"));
  monitor.stop();
});

test("a failure after a good read keeps the quota, marked as old", async () => {
  let failing = false;
  const monitor = monitorWith(async () => {
    if (failing) throw new ReadError("Source unavailable or the query timed out.");
    return [okSnapshot];
  });
  await monitor.refresh();
  failing = true;
  await monitor.refresh();
  const [s] = monitor.snapshots("opencode");
  assert.equal(s.windows.length, 1);
  assert.equal(s.stale, true);
  assert.equal(s.error, "Source unavailable or the query timed out.");
  monitor.stop();
});

// --- collectors: per-provider errors ---

test("OpenCode without a key stays disabled with instructions, not an error", async () => {
  await isolated({}, async () => {
    const [s] = await COLLECTORS.opencode();
    assert.equal(s.disabled, true);
    assert.match(s.error ?? "", /OPENCODE_GO_KEY/);
  });
});

test("Codex missing from PATH stays disabled with instructions", async () => {
  await isolated({}, async (home) => {
    const empty = join(home, "empty");
    await mkdir(empty);
    await isolated({ PATH: empty }, async () => {
      const [s] = await COLLECTORS.openai();
      assert.equal(s.disabled, true);
      assert.equal(s.error, "Codex CLI not found on PATH.");
    });
  });
});

/** Creates a fake "codex" in its own folder; the script runs in place of the real binary. */
async function fakeCodex(home: string, lines: string[]): Promise<string> {
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "codex"), ["#!/bin/sh", ...lines].join("\n") + "\n");
  await chmod(join(bin, "codex"), 0o755);
  return bin;
}

test("Codex that exits without answering becomes a readable error", async () => {
  await isolated({}, async (home) => {
    const bin = await fakeCodex(home, ["exit 0"]);
    await isolated({ PATH: bin }, async () => {
      const error = await errorOf(COLLECTORS.openai());
      assert.equal(error.message, "Codex did not answer the quota read.");
    });
  });
});

test("Codex that refuses the read becomes a readable error", async () => {
  await isolated({}, async (home) => {
    const bin = await fakeCodex(home, ["read a", "read b", "read c", 'echo \'{"id":2,"error":{"code":-1}}\''] );
    await isolated({ PATH: bin }, async () => {
      const error = await errorOf(COLLECTORS.openai());
      assert.equal(error.message, "Codex refused the quota read.");
    });
  });
});

test("Claude history in an unknown format becomes an error in the report", async () => {
  await isolated({}, async (home) => {
    const dir = join(home, "config", "Claude");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plan-usage-history.json"), '{"nope":1}');
    const [s] = await COLLECTORS.claude();
    assert.equal(s.error, "Claude history in an unknown format.");
  });
});

test("a missing Codex vanishes from the report; another provider without a key stays listed", () => {
  const codexOff: Snapshot = { id: "openai", name: "OpenAI Codex", windows: [], source: "codex app-server",
    error: "Codex CLI not found on PATH.", disabled: true };
  const ocOff: Snapshot = { id: "opencode", name: "OpenCode Go", windows: [], source: "x",
    error: "Set OPENCODE_GO_KEY.", disabled: true };
  const text = report([codexOff, ocOff], Date.now() / 1000);
  assert.ok(!text.includes("Codex"), "Codex must not appear");
  assert.match(text, /Not configured: OpenCode Go\./);
});
