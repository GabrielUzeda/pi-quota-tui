// HTTP paths with fetch mocked: Claude OAuth usage and the /quota-login loopback, end to end, offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginAgy } from "../src/agy-login.ts";
import { COLLECTORS, setOAuthRefresh } from "../src/providers.ts";

const realFetch = globalThis.fetch;
type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** Temp HOME and agent dir, fetch routed by host; loopback still reaches the real local server. */
async function offline(route: Route, fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "pqt-net-"));
  const keys = ["HOME", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "PI_QUOTA_TUI_AGY_ACCOUNTS"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), XDG_CONFIG_HOME: join(home, "c"), XDG_DATA_HOME: join(home, "d"),
    PI_QUOTA_TUI_AGY_ACCOUNTS: join(home, "agy.json"),
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    return url.hostname === "127.0.0.1" ? realFetch(input, init) : route(url, init);
  };
  try {
    await fn(home);
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    await rm(home, { recursive: true, force: true });
  }
}

async function writeAuth(home: string, data: unknown): Promise<void> {
  // PI_CODING_AGENT_DIR, not ~/.pi/agent: proves auth.json follows pi's agent dir.
  await mkdir(join(home, "agent"), { recursive: true });
  await writeFile(join(home, "agent", "auth.json"), JSON.stringify(data), { mode: 0o600 });
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("Claude OAuth over HTTP: the bearer token reaches the API and the answer becomes windows", () =>
  offline((url, init) => {
    assert.equal(url.href, "https://api.anthropic.com/api/oauth/usage");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer tok");
    return json({ five_hour: { utilization: 42, resets_at: "2030-01-01T00:00:00Z" }, seven_day: { utilization: 7 } });
  }, async (home) => {
    setOAuthRefresh(undefined);
    await writeAuth(home, { anthropic: { type: "oauth", access: "tok" } });
    const [snap] = await COLLECTORS.claude();
    assert.equal(snap.error, undefined);
    assert.deepEqual(snap.windows.map((w) => [w.label, w.used]), [["5 hours", 42], ["Weekly", 7]]);
  }));

test("Claude OAuth over HTTP: 401 and a network failure become safe errors without the token", async () => {
  for (const [route, expected] of [
    [() => json({ error: "expired tok" }, 401), /HTTP 401/],
    [() => { throw new TypeError("fetch failed tok"); }, /unavailable/],
  ] as const) {
    await offline(route, async (home) => {
      setOAuthRefresh(undefined);
      await writeAuth(home, { anthropic: { type: "oauth", access: "tok" } });
      const [snap] = await COLLECTORS.claude();
      assert.match(snap.error ?? "", expected);
      assert.doesNotMatch(snap.error ?? "", /tok/);
    });
  }
});

/** Plays the browser: opens the callback the extension printed, with the given query. */
function browser(query: (state: URLSearchParams) => string, seen: { challenge?: string }) {
  return (message: string) => {
    const link = message.match(/https:\/\/\S+/)?.[0];
    if (!link) return;
    const consent = new URL(link).searchParams;
    seen.challenge = consent.get("code_challenge") ?? undefined;
    void realFetch(consent.get("redirect_uri") + "?" + query(consent));
  };
}

test("/quota-login loopback: browser code, PKCE exchange, private accounts file", () => {
  const seen: { challenge?: string } = {};
  const idToken = "h." + Buffer.from(JSON.stringify({ email: "me@example.com" })).toString("base64url") + ".s";
  return offline(async (url, init) => {
    assert.equal(url.href, "https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("code"), "the-code");
    // The verifier sent now must hash to the challenge shown in the consent URL.
    assert.equal(createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url"), seen.challenge);
    return json({ refresh_token: "r1", id_token: idToken });
  }, async (home) => {
    const notes: string[] = [];
    const open = browser(() => "code=the-code", seen);
    await loginAgy((message) => (notes.push(message), open(message)));
    const file = join(home, "agy.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), [{ refreshToken: "r1", email: "me@example.com" }]);
    assert.match(notes.at(-1) ?? "", /me@example\.com/);
  });
});

test("/quota-login loopback: a cancelled consent rejects and saves nothing", () =>
  offline(() => assert.fail("no token exchange after a cancel"), async (home) => {
    await assert.rejects(loginAgy(browser(() => "error=access_denied", {})), /cancelled/);
    await assert.rejects(stat(join(home, "agy.json")));
  }));
