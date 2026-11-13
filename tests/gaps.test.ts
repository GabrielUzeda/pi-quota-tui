// The gaps left open by the other suites: the private-file rule, the Cloud Code host fallback,
// the login import routes and the tool's own guard against an unknown source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "../src/index.ts";
import { agyAccountsPath, agyLegacyPath, COLLECTORS, readPrivateJson } from "../src/providers.ts";
import { loginAgy } from "../src/agy-login.ts";

const realFetch = globalThis.fetch;
type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** Temp HOME and agent dir, fetch routed by host, everything restored afterwards. */
async function offline(route: Route, fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "pqt-gaps-"));
  const keys = ["HOME", "PI_CODING_AGENT_DIR", "PI_QUOTA_TUI_AGY_ACCOUNTS"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, "agent"),
    PI_QUOTA_TUI_AGY_ACCOUNTS: join(home, "agy.json"),
  });
  globalThis.fetch = async (input, init) => route(new URL(String(input)), init);
  try {
    await fn(home);
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    await rm(home, { recursive: true, force: true });
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("readPrivateJson: an account file readable by others is ignored, not parsed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pqt-private-"));
  try {
    const file = join(dir, "accounts.json");
    // Refresh tokens on disk: word for this user only, like auth.json.
    await writeFile(file, JSON.stringify([{ refreshToken: "r1" }]), { mode: 0o644 });
    assert.equal(await readPrivateJson(file), undefined);
    await chmod(file, 0o600);
    assert.deepEqual(await readPrivateJson(file), [{ refreshToken: "r1" }]);
    // Garbage and a missing file: no exception reaches the panel.
    await writeFile(file, "{not json", { mode: 0o600 });
    assert.equal(await readPrivateJson(file), undefined);
    assert.equal(await readPrivateJson(join(dir, "missing.json")), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Antigravity: the second Cloud Code host answers when the first one has no groups", () =>
  offline((url) => {
    if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "at" });
    if (url.hostname === "daily-cloudcode-pa.googleapis.com") return json({});
    return json({ groups: [{ displayName: "Gemini 4 Argon models", buckets: [{ window: "5h", remainingFraction: 0.25 }] }] });
  }, async (home) => {
    const seen: string[] = [];
    const route = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(new URL(String(input)).hostname);
      return route(input as never, init);
    };
    await writeFile(agyAccountsPath(), JSON.stringify([{ refreshToken: "r1", email: "me@example.com" }]), { mode: 0o600 });
    const [snap] = await COLLECTORS.antigravity();
    assert.deepEqual(seen, ["oauth2.googleapis.com", "daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"]);
    assert.equal(snap.error, undefined);
    assert.deepEqual(snap.windows.map((w) => [w.group, w.label, w.used]), [["Argon", "5 hours", 75]]);
    assert.match(snap.note ?? "", /^PAID /);
    assert.equal(snap.id, "antigravity");
    assert.equal(home, process.env.HOME);
  }));

test("Antigravity: both hosts refusing keeps the account visible with a safe error", () =>
  offline((url) => (url.hostname === "oauth2.googleapis.com" ? json({ access_token: "secret-at" }) : json({}, 403)), async () => {
    await writeFile(agyAccountsPath(), JSON.stringify([{ refreshToken: "r1" }]), { mode: 0o600 });
    const snapshots = await COLLECTORS.antigravity();
    assert.equal(snapshots.length, 1);
    assert.deepEqual(snapshots[0].windows, []);
    assert.match(snapshots[0].error ?? "", /HTTP 403/);
    assert.doesNotMatch(snapshots[0].error ?? "", /secret-at/);
  }));

test("/quota-login skips the Google consent when the accounts are still valid, and imports from AGY", () =>
  offline((url, init) => {
    assert.equal(url.hostname, "oauth2.googleapis.com");
    // Only the token Google still renews; "dead" answers 400 like a revoked one.
    const form = new URLSearchParams(String(init?.body));
    return form.get("refresh_token") === "dead" ? json({ error: "invalid_grant" }, 400) : json({ access_token: "at" });
  }, async (home) => {
    // Own file, both tokens renewed by Google: nothing to do, nothing rewritten.
    const target = agyAccountsPath();
    const before = JSON.stringify([{ refreshToken: "good", email: "a@b.c" }]);
    await writeFile(target, before, { mode: 0o600 });
    const notes: string[] = [];
    await loginAgy((message) => notes.push(message));
    assert.deepEqual(notes, ["Antigravity: 1 account(s) already validated in " + target + "."]);
    assert.equal(await readFile(target, "utf8"), before);

    // Own file gone, AGY keeps a valid account: imported, private, no browser opened.
    await rm(target);
    const legacy = agyLegacyPath();
    await mkdir(join(home, ".local", "share", "agy-local-proxy"), { recursive: true });
    await writeFile(legacy, JSON.stringify([{ refreshToken: "r2", email: "x@y.z" }, { refreshToken: "dead" }]), { mode: 0o600 });
    const imported: string[] = [];
    await loginAgy((message) => imported.push(message));
    assert.deepEqual(imported, ["Antigravity: 1 account(s) imported from AGY into " + target + "."]);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), [{ refreshToken: "r2", email: "x@y.z" }]);
  }));

test("get_quotas tool: an unknown source is refused before any collection", async () => {
  const tools: { name: string; execute: (id: string, params: { source?: string }) => Promise<{ content: { text: string }[]; details: { source: string } }> }[] = [];
  factory({
    registerCommand() {},
    registerTool(tool: unknown) { tools.push(tool as never); },
    registerEntryRenderer() {},
    appendEntry() {},
    on() {},
  } as never);
  const tool = tools.find((t) => t.name === "get_quotas");
  assert.ok(tool);
  const result = await tool.execute("call", { source: "opencode-go" });
  assert.deepEqual(result.details, { source: "opencode-go" });
  assert.equal(result.content[0].text, "Unknown source: opencode-go. Use: all, opencode, agy, commandcode.");
});
