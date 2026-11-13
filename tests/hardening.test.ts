// Hardening: hostile inputs, numeric edges, collection failures and unexpected states.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { bar, details, report, resolveSource } from "../src/format.ts";
import { countdown, delta, forecast, health, pace, resetText } from "../src/rules.ts";
import { outdated, type Snapshot, type Window } from "../src/models.ts";
import {
  agySnapshot, clamped, collapse, COLLECTORS, epoch, estimateReset, nextMonthlyReset, num, oauthAccess, paidIndex,
  parseAgyAccounts, parseCodex, parseCommandcode, parseGroups, parseJson, parseOauthUsage, parseOpencode, readJson,
  ReadError, secret, setOAuthRefresh,
} from "../src/providers.ts";
import { QuotaPanel } from "../src/panel.ts";
import { Monitor } from "../src/service.ts";

const NOW = 1_800_000_000;
const bad = (value: unknown) => (async () => value) as unknown as () => Promise<Snapshot[]>;
const ok = (snapshots: Snapshot[]) => async () => snapshots;
const win = (used: number, extra: Partial<Window> = {}): Window => ({ label: "5 hours", used, ...extra });
const snap = (id: string, extra: Partial<Snapshot> = {}): Snapshot => ({
  id, name: id, windows: [win(10)], updatedAt: NOW, source: "test", ...extra,
});

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Empty temp home: HOME, XDG and keys isolated; nothing real is read. */
async function sandbox(fn: (home: string) => Promise<void>, extra: Record<string, string | undefined> = {}): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "nt-sandbox-"));
  try {
    await withEnv(
      {
        HOME: home,
        XDG_DATA_HOME: join(home, "data"),
        XDG_CONFIG_HOME: join(home, "config"),
        OPENCODE_GO_KEY: undefined,
        COMMAND_CODE_API_KEY: undefined,
        COMMANDCODE_API_KEY: undefined,
        ...extra,
      },
      () => fn(home),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeAuth(home: string, content: string, mode = 0o600): Promise<void> {
  const dir = join(home, ".pi", "agent");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "auth.json");
  await writeFile(file, content);
  await chmod(file, mode);
}

/** Fake Codex: each line becomes a command in the shell script. */
async function fakeCodex(home: string, lines: string[]): Promise<string> {
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "codex"), ["#!/bin/sh", ...lines].join("\n") + "\n");
  await chmod(join(bin, "codex"), 0o755);
  return bin;
}

// --- numbers, dates and JSON ---

test("num rejects infinity, negative, out of range and text", () => {
  assert.equal(num(Infinity), undefined);
  assert.equal(num(-1), undefined);
  assert.equal(num(101), undefined);
  assert.equal(num("5"), undefined);
  assert.equal(num(100), 100);
});

test("clamped limits the value instead of dropping it, but does not accept text", () => {
  assert.equal(clamped(150, 0, 100), 100);
  assert.equal(clamped(-3, 0, 100), 0);
  assert.equal(clamped(NaN, 0, 100), undefined);
  assert.equal(clamped(Infinity, 0, 100), undefined);
  assert.equal(clamped("50", 0, 100), undefined);
});

test("epoch accepts seconds, milliseconds and ISO with or without a timezone", () => {
  assert.equal(epoch(1_800_000_000), 1_800_000_000);
  assert.equal(epoch(1_800_000_000_000), 1_800_000_000);
  assert.equal(epoch("2026-01-01T00:00:00"), Date.UTC(2026, 0, 1) / 1000);
  assert.equal(epoch("2026-01-01T00:00:00-03:00"), Date.UTC(2026, 0, 1, 3) / 1000);
});

test("epoch refuses garbage, zero, negatives, absurd dates and wrong types", () => {
  const values: unknown[] = ["nope", "2026-13-45", 0, -5, NaN, 1e16, true, null, {}];
  for (const value of values) assert.equal(epoch(value), undefined, String(value));
});

test("parseJson accepts a BOM and rejects text that is not JSON", () => {
  assert.deepEqual(parseJson('\uFEFF{"a":1}'), { a: 1 });
  assert.throws(() => parseJson("{nope"), SyntaxError);
});

// --- OpenCode ---

test("OpenCode: a percentage above 100 becomes 100 and below 0 becomes 0", () => {
  const s = parseOpencode({ usage: { rolling: { percent: 150 }, weekly: { percent: -4 } } }, NOW);
  assert.equal(s.windows[0].used, 100);
  assert.equal(s.windows[1].used, 0);
});

test("OpenCode: a percentage as text is ignored and no windows becomes an error", () => {
  assert.throws(() => parseOpencode({ usage: { rolling: { percent: "50" } } }, NOW), ReadError);
});

test("OpenCode: a usage that is not an object becomes an error", () => {
  assert.throws(() => parseOpencode({ usage: [1, 2] }, NOW), ReadError);
});

test("OpenCode: a response without the usage key uses the object itself", () => {
  const s = parseOpencode({ monthly: { percent: 12 } }, NOW);
  assert.equal(s.windows[0].label, "Monthly");
});

test("OpenCode: the monthly has a 30 day cycle and, with 2 days to renew, stays on pace", () => {
  const s = parseOpencode({ usage: { monthly: { percent: 90, resetsAt: NOW + 2 * 86400 } } }, NOW);
  const w = s.windows[0];
  assert.equal(w.duration, 30 * 86400);
  assert.ok(pace(w, NOW) !== undefined);
  assert.ok(delta(w, NOW)! < 0); // 90% used and less than the ~93% of the cycle
});

// --- CommandCode ---

test("CommandCode: a wallet that is not an object is a ReadError", () => {
  assert.throws(() => parseCommandcode({ credits: "x" }, undefined, NOW), ReadError);
});

test("CommandCode: negative or text credits count as zero", () => {
  const s = parseCommandcode({ credits: { monthlyCredits: -5, purchasedCredits: "9", freeCredits: 2 } }, undefined, NOW);
  assert.match(s.note ?? "", /Balance 2\.00 /);
});

test("CommandCode: the monthly window stays between 0 and 100 even with huge consumption", () => {
  const s = parseCommandcode({ credits: { monthlyCredits: 10 } }, { totalMonthlyCredits: 1e15 }, NOW);
  const monthly = s.windows.find((w) => w.label === "Monthly");
  assert.ok(monthly !== undefined && monthly.used >= 0 && monthly.used <= 100);
  const none = parseCommandcode({ credits: { monthlyCredits: 0 } }, undefined, NOW);
  assert.equal(none.windows.some((w) => w.label === "Monthly"), false);
});

test("CommandCode: a 5h window with zero capacity is ignored", () => {
  const s = parseCommandcode(
    { credits: { monthlyCredits: 1, windowLimits: { fiveHour: { cap: 0, used: 5 } } } }, undefined, NOW);
  assert.equal(s.windows.some((w) => w.label === "5 hours"), false);
  assert.match(s.note ?? "", /no 5h\/weekly window/);
});


test("nextMonthlyReset caps the day at 1..28", () => {
  const jan20 = Date.UTC(2026, 0, 20) / 1000;
  assert.equal(nextMonthlyReset(31, jan20), Date.UTC(2026, 0, 28) / 1000);
  assert.equal(nextMonthlyReset(0, jan20), Date.UTC(2026, 1, 1) / 1000);
  assert.equal(nextMonthlyReset(-5, jan20), Date.UTC(2026, 1, 1) / 1000);
});

test("nextMonthlyReset: on the reset day itself it already moves to the next month; December becomes January", () => {
  const jan16 = Date.UTC(2026, 0, 16) / 1000;
  assert.equal(nextMonthlyReset(16, jan16), Date.UTC(2026, 1, 16) / 1000);
  const dec20 = Date.UTC(2026, 11, 20) / 1000;
  assert.equal(nextMonthlyReset(16, dec20), Date.UTC(2027, 0, 16) / 1000);
});

// --- Antigravity / Cloud Code (no proxy) ---

const agyAccount = (extra: Record<string, unknown> = {}) => ({ email: "a@x", projectId: "p", refreshToken: "r", ...extra });
const agyGroups5h = [{ displayName: "Gemini", buckets: [{ window: "5h", remainingFraction: 0.5 }] }];

test("Antigravity: an account without a refreshToken does not enter the list; garbage does not break the others", () => {
  const accounts = parseAgyAccounts([null, 3, "x", { email: "a@x" }, { email: "b@x", refreshToken: "r" }]);
  assert.equal(accounts.length, 1);
  assert.equal(parseAgyAccounts(undefined).length, 0);
});

test("Antigravity: an account becomes a snapshot with an id derived from the e-mail and no summing of percentages", () => {
  const accounts = parseAgyAccounts([agyAccount()]);
  const s = agySnapshot(accounts[0], 0, agyGroups5h, NOW);
  assert.equal(s.id, "antigravity/" + createHash("sha256").update("a@x").digest("hex").slice(0, 10));
  assert.equal(s.windows.length, 1);
  assert.equal(s.windows[0].used, 50);
  assert.equal(s.source, "Antigravity / Cloud Code");
  assert.match(s.note ?? "", /neither summed nor averaged/);
  assert.equal(agySnapshot(accounts[0], 0, [], NOW).error, "Account has no recognized quota reading.");
});

test("Antigravity: paidIndex uses the hint and, without it, the account with most windows read", () => {
  const accounts = parseAgyAccounts([agyAccount(), agyAccount({ email: "b@x", projectId: "proj-b" })]);
  const snaps = [agySnapshot(accounts[0], 0, agyGroups5h, NOW), agySnapshot(accounts[1], 1, [], NOW)];
  assert.equal(paidIndex(accounts, snaps, "b@x"), 1);
  assert.equal(paidIndex(accounts, snaps, "proj-b"), 1);
  assert.equal(paidIndex(accounts, snaps, ""), 0);
  // the account hash (snapshot id) also works as a hint
  assert.equal(paidIndex(accounts, snaps, snaps[1].id.split("/")[1]), 1);
});

test("Antigravity: collapse picks the paid one and summarizes the others as BONUS", () => {
  const accounts = parseAgyAccounts([agyAccount(), agyAccount({ email: "b@x" })]);
  const snaps = [agySnapshot(accounts[0], 0, agyGroups5h, NOW), agySnapshot(accounts[1], 1, [], NOW)];
  const merged = collapse(snaps, paidIndex(accounts, snaps, "a@x"), NOW);
  const expected = createHash("sha256").update("a@x").digest("hex").slice(0, 6);
  assert.equal(merged.id, "antigravity");
  assert.match(merged.note ?? "", new RegExp("^PAID " + expected));
  assert.match(merged.note ?? "", /BONUS 1 accounts without a reading/);
});

test("AGY: parseGroups ignores invalid groups and buckets and limits the fraction", () => {
  const w = parseGroups([
    null,
    { displayName: 5, buckets: [] },
    { displayName: "Gemini Pro models", buckets: "x" },
    {
      displayName: "Gemini Pro models",
      buckets: [
        { window: "5h", remainingFraction: 2, resetTime: "2026-01-01T00:00:00Z" },
        { window: "5h", remainingFraction: "0.5" },
        { window: "5h", remainingFraction: 0.5, disabled: true },
      ],
    },
  ]);
  assert.equal(w.length, 1);
  assert.equal(w[0].used, 0);
  assert.equal(w[0].group, "Gemini Pro");
});

test('AGY: the Argon group becomes "Argon" and keeps the weekly window', () => {
  const [w] = parseGroups([{
    displayName: "Gemini 4 Argon",
    buckets: [{ window: "weekly", remainingFraction: 0.0154, resetTime: "2026-10-26T14:39:30Z" }],
  }]);
  assert.equal(w.group, "Argon");
  assert.equal(w.label, "Weekly");
  assert.equal(w.duration, 604800);
  assert.ok(Math.abs(w.used - 98.46) < 0.01);
});

// --- Codex ---

test("Codex: a percentage above 100 becomes 100 and an unknown duration gets no 5 hours label", () => {
  const s = parseCodex({
    rateLimits: { primary: { usedPercent: 150, windowDurationMins: 999 }, secondary: { usedPercent: 5, windowDurationMins: 10080 } },
  }, NOW);
  assert.equal(s.windows[0].used, 100);
  assert.equal(s.windows[0].label, "999 min window");
  assert.equal(s.windows[0].duration, undefined);
  assert.equal(s.windows[1].label, "Weekly");
});

test("Codex: a 30-day window is Monthly, with a cycle, so it gets pace and health", () => {
  const s = parseCodex({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: 43200, resetsAt: NOW + 29 * 86400 } } }, NOW);
  const [w] = s.windows;
  assert.equal(w.label, "Monthly");
  assert.equal(w.duration, 2592000);
  assert.equal(health(s, NOW), "ON TRACK");
});

test("Codex: no limits or no usable percentage becomes a readable error", () => {
  assert.throws(() => parseCodex({}, NOW), /did not report quota limits/);
  assert.throws(() => parseCodex({ rateLimits: { primary: { usedPercent: "x" } } }, NOW), /without a usable percentage/);
});

test("Codex: without the 'codex' bucket it uses the first available", () => {
  const s = parseCodex({ rateLimitsByLimitId: { other: { primary: { usedPercent: 33, windowDurationMins: 300 } } } }, NOW);
  assert.equal(s.windows[0].used, 33);
});

test("Codex: a reset count that is not an integer generates no note", () => {
  const s = parseCodex({ rateLimits: { primary: { usedPercent: 1 } }, rateLimitResetCredits: { availableCount: 1.5 } }, NOW);
  assert.equal(s.note, "");
});

test("Codex: the read through the (fake) app-server brings the windows, even with garbage before the response", () =>
  sandbox(async (home) => {
    const result = '{"id":2,"result":{"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":40,"windowDurationMins":300,"resetsAt":1900000000}}},"rateLimitResetCredits":{"availableCount":2}}}';
    const bin = await fakeCodex(home, ["read a", "read b", "read c", "echo 'garbage that is not JSON'", "echo '" + result + "'", "read d"]);
    await withEnv({ PATH: bin }, async () => {
      const [s] = await COLLECTORS.openai();
      assert.equal(s.windows[0].used, 40);
      assert.match(s.note ?? "", /2 limit reset/);
    });
  }));

test("Codex: other providers' keys do not go to the subprocess", () =>
  sandbox(async (home) => {
    const bin = await fakeCodex(home, ['echo "OPENCODE_GO_KEY=${OPENCODE_GO_KEY:-missing}" > "$HOME/leak.txt"']);
    await withEnv({ PATH: bin, OPENCODE_GO_KEY: "secret-key" }, async () => {
      await COLLECTORS.openai().catch(() => undefined);
      assert.equal(await readFile(join(home, "leak.txt"), "utf8"), "OPENCODE_GO_KEY=missing\n");
    });
  }));


test("Claude: with no local data it stays disabled with the instruction", () =>
  sandbox(async () => {
    const [s] = await COLLECTORS.claude();
    assert.equal(s.disabled, true);
    assert.match(s.error ?? "", /desktop app/);
  }));

test("Claude: corrupted history becomes an error in the report, without breaking the collection", () =>
  sandbox(async (home) => {
    const dir = join(home, "config", "Claude");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plan-usage-history.json"), "{garbage");
    const [s] = await COLLECTORS.claude();
    assert.equal(s.error, "Could not read the Claude app history.");
  }));

test("Claude: history with several accounts uses only the most recent one", () =>
  sandbox(async (home) => {
    const real = Date.now() / 1000;
    const dir = join(home, "config", "Claude");
    await mkdir(dir, { recursive: true });
    const samples = [
      { t: (real - 600) * 1000, org: "A", u: { fh: 10 } },
      { t: (real - 60) * 1000, org: "B", u: { fh: 40 } },
    ];
    await writeFile(join(dir, "plan-usage-history.json"), JSON.stringify({ samples }));
    const [s] = await COLLECTORS.claude();
    assert.equal(s.windows[0].used, 40);
  }));

test("Claude: history without recorded usage invents no window and lets OAuth take over", () =>
  sandbox(async (home) => {
    const real = Date.now() / 1000;
    const dir = join(home, "config", "Claude");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plan-usage-history.json"), JSON.stringify({ samples: [{ t: real * 1000, org: "A", u: {} }] }));
    const [s] = await COLLECTORS.claude();
    assert.equal(s.windows.length, 0);
    assert.equal(s.disabled, true);
    assert.match(s.error ?? "", /log in/);
  }));

test("Claude: an expired 5h window does not estimate the renewal time", () =>
  sandbox(async (home) => {
    const real = Date.now() / 1000;
    const dir = join(home, "config", "Claude");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plan-usage-history.json"), JSON.stringify({ samples: [{ t: (real - 40000) * 1000, org: "A", u: { fh: 30 } }] }));
    const [s] = await COLLECTORS.claude();
    assert.equal(s.windows[0].resetsAt, undefined);
    assert.match(s.note ?? "", /window expired/);
  }));

test("Claude OAuth: the registry token wins over the expired one in auth.json", () =>
  sandbox(async (home) => {
    await writeAuth(home, JSON.stringify({ anthropic: { type: "oauth", access: "expired", refresh: "r", expires: 1 } }));
    setOAuthRefresh(async (section) => (section === "anthropic" ? " fresh " : undefined));
    try {
      assert.equal(await oauthAccess("anthropic"), "fresh");
    } finally {
      setOAuthRefresh(undefined);
    }
  }));

test("Claude OAuth: a failed refresh and an api-key section fall back to auth.json", () =>
  sandbox(async (home) => {
    await writeAuth(home, JSON.stringify({ anthropic: { type: "oauth", access: "kept", refresh: "r", expires: 1 } }));
    setOAuthRefresh(async () => {
      throw new Error("lock unavailable");
    });
    try {
      assert.equal(await oauthAccess("anthropic"), "kept");
      setOAuthRefresh(async () => "not-an-oauth-token");
      await writeAuth(home, JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-api" } }));
      assert.equal(await oauthAccess("anthropic"), "");
    } finally {
      setOAuthRefresh(undefined);
    }
  }));

test("estimateReset: weekly is never invented", () => {
  const rows = [{ at: NOW - 100, sd: 20 }];
  assert.equal(estimateReset(rows, "sd", 0, NOW, 604800)[0], undefined);
});

test("estimateReset: with the window starting after a zero, it estimates the middle of the gap + duration", () => {
  const rows = [{ at: NOW - 8000, fh: 0 }, { at: NOW - 1000, fh: 20 }];
  const [resetsAt] = estimateReset(rows, "fh", 1, NOW, 18000);
  assert.equal(resetsAt, NOW - 4500 + 18000);
});

test("estimateReset: without a previous reference sample it does not estimate", () => {
  const rows = [{ at: NOW - 1000, fh: 20 }];
  assert.equal(estimateReset(rows, "fh", 0, NOW, 18000)[0], undefined);
});

// --- Claude: subscription OAuth ---

test("Claude OAuth: utilization and resets_at become 5h and weekly windows", () => {
  const s = parseOauthUsage({
    five_hour: { utilization: 42, resets_at: "2030-01-01T00:00:00Z" },
    seven_day: { utilization: 180, resets_at: "2030-01-02T00:00:00Z", locked_reason: "limit" },
    extra_usage: { utilization: 99 },
  }, NOW);
  assert.deepEqual(s.windows.map((w) => [w.label, w.used, w.duration]), [["5 hours", 42, 18000], ["Weekly", 100, 604800]]);
  assert.equal(s.windows[0].resetsAt, Date.parse("2030-01-01T00:00:00Z") / 1000);
  assert.match(s.note ?? "", /locked: Weekly/);
});

test("Claude OAuth: no recognized window is a ReadError", () => {
  assert.throws(() => parseOauthUsage({ extra_usage: { utilization: 10 }, seven_day_opus: { utilization: 5 } }, NOW), ReadError);
});

// --- credentials ---

test("secret: auth.json takes priority over the environment variable", () =>
  sandbox(async (home) => {
    await writeAuth(home, JSON.stringify({ "opencode-go": { key: "from-file" } }));
    await withEnv({ OPENCODE_GO_KEY: "from-env" }, async () => {
      assert.equal(await secret(["OPENCODE_GO_KEY"], "opencode-go"), "from-file");
    });
  }));

test("secret: without auth.json the environment variable is the fallback", () =>
  sandbox(async () => {
    await withEnv({ OPENCODE_GO_KEY: "from-env" }, async () => {
      assert.equal(await secret(["OPENCODE_GO_KEY"], "opencode-go"), "from-env");
    });
  }));

test("secret: a blank key in auth.json falls back to the environment variable", () =>
  sandbox(async (home) => {
    await writeAuth(home, JSON.stringify({ "opencode-go": { key: "   " } }));
    await withEnv({ OPENCODE_GO_KEY: "from-env" }, async () => {
      assert.equal(await secret(["OPENCODE_GO_KEY"], "opencode-go"), "from-env");
    });
  }));

test("secret: auth.json with group or other permissions is ignored", () =>
  sandbox(async (home) => {
    await writeAuth(home, JSON.stringify({ "opencode-go": { key: "from-file" } }), 0o644);
    assert.equal(await secret(["OPENCODE_GO_KEY"], "opencode-go"), "");
  }));

test("secret: corrupted auth.json, a list, a non-object section or a non-text key is ignored", () =>
  sandbox(async (home) => {
    const cases = ["{nope", "[1]", JSON.stringify({ "opencode-go": "text" }), JSON.stringify({ "opencode-go": { key: 42 } })];
    for (const content of cases) {
      await writeAuth(home, content);
      assert.equal(await secret(["OPENCODE_GO_KEY"], "opencode-go"), "", content);
    }
  }));

test("secret: auth.json with a BOM is read normally", () =>
  sandbox(async (home) => {
    await writeAuth(home, "\uFEFF" + JSON.stringify({ "opencode-go": { key: "bom-key" } }));
    assert.equal(await secret(["OPENCODE_GO_KEY"], "opencode-go"), "bom-key");
  }));

// --- HTTP: extra cases ---

let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/204") {
      res.statusCode = 204;
      res.end();
    } else if (req.url === "/null") {
      res.end("null");
    } else if (req.url === "/bom") {
      res.end("\uFEFF" + '{"a":1}');
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

test("readJson: a 204 response without a body is an invalid response", async () => {
  await assert.rejects(readJson(base + "/204", { timeout: 2 }), { message: "Invalid quota response." });
});

test("readJson: JSON null is an unrecognized format", async () => {
  await assert.rejects(readJson(base + "/null", { timeout: 2 }), { message: "Unrecognized quota format." });
});

test("readJson: a BOM in the response is accepted", async () => {
  assert.deepEqual(await readJson(base + "/bom", { timeout: 2 }), { a: 1 });
});

test("readJson: localhost and IPv6 over HTTP are refused (only 127.0.0.1)", async () => {
  for (const url of ["http://localhost:1/x", "http://[::1]:1/x", "http://0.0.0.0:1/x"]) {
    await assert.rejects(readJson(url, { timeout: 1 }), (error: unknown) =>
      error instanceof ReadError && error.message === "Plain HTTP allowed only on loopback.", url);
  }
});

// --- rules, models and report ---

test("pace: without reset, without duration, outdated or already past there is no pace", () => {
  assert.equal(pace(win(10), NOW), undefined);
  assert.equal(pace(win(10, { resetsAt: NOW + 100, duration: 18000 }), NOW, true), undefined);
  assert.equal(pace(win(10, { resetsAt: NOW - 5, duration: 18000 }), NOW), undefined);
});

test("forecast: an exhausted quota invents no forecast; without pace it stays empty", () => {
  assert.equal(forecast(win(100, { resetsAt: NOW + 100, duration: 18000 }), NOW), "QUOTA EXHAUSTED; waiting for renewal");
  assert.equal(forecast(win(10), NOW), "");
});

test("health: a read with an error or old becomes OUTDATED", () => {
  assert.equal(health(snap("x", { error: "x" }), NOW), "OUTDATED");
  assert.equal(health(snap("x", { updatedAt: NOW - 600 }), NOW), "OUTDATED");
});

test("outdated: a future time or a past reset is old; a disabled one never is", () => {
  assert.equal(outdated(snap("x", { updatedAt: NOW + 3600 }), NOW), true);
  assert.equal(outdated(snap("x", { windows: [win(1, { resetsAt: NOW - 1 })] }), NOW), true);
  assert.equal(outdated(snap("x", { disabled: true }), NOW), false);
});

test("countdown: zero, days and hours format without NaN", () => {
  assert.equal(countdown(0), "1min");
  assert.equal(countdown(190800), "2d 5h");
});

test("resetText: without reset, past and estimated", () => {
  assert.equal(resetText(win(1), NOW), "RESETS: time unavailable");
  assert.equal(resetText(win(1, { resetsAt: NOW - 5 }), NOW), "WAITING FOR NEW DATA");
  assert.equal(resetText(win(1, { resetsAt: NOW + 3600 }), NOW), "RESETS IN 1h 00min");
  assert.equal(resetText(win(1, { resetsAt: NOW + 3600, estimated: true }), NOW), "RESETS IN ~1h 00min");
});

test("bar: usage above 100, a reference out of range and the minimum width do not break", () => {
  const full = bar(150, undefined, 20);
  assert.equal(full.length, 20);
  assert.ok(!full.includes("░"));
  const ref = bar(-10, 200, 10);
  assert.equal(ref.length, 10);
  assert.ok(ref.endsWith("│"));
  assert.equal(bar(50, -50, 10).indexOf("│"), 0);
  assert.equal(bar(0, undefined, 1).length, 1);
});

test("report: an empty list does not break; details without reset or duration say so", () => {
  assert.match(report([], NOW), /QUOTA WATCH/);
  const lines = details(snap("x", { name: "X", windows: [win(40)] }), NOW);
  assert.ok(lines.some((l) => l.includes("PACE UNAVAILABLE")));
  assert.ok(lines.some((l) => l.includes("RESETS: time unavailable")));
});

test("resolveSource: names inherited from object, spaces and uppercase", () => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "cmd", "x y"])
    assert.equal(resolveSource(name).valid, false, name);
  assert.equal(resolveSource("  AGY ").provider, "antigravity");
  assert.equal(resolveSource("ALL").valid, true);
  assert.equal(resolveSource("").valid, true);
  assert.equal(resolveSource("").provider, undefined);
});

// --- Monitor: collection failures ---

test("monitor: a provider failure does not affect the others", async () => {
  const m = new Monitor({
    a: ok([snap("a")]),
    b: async () => {
      throw new TypeError("boom");
    },
  });
  await m.refresh();
  assert.equal(m.snapshots("a")[0].windows.length, 1);
  assert.equal(m.snapshots("b")[0].error, "Internal read failure; last quota kept.");
  m.stop();
});

test("monitor: an unexpected response (undefined, object, text, null) becomes an error, without an exception", async () => {
  const values: unknown[] = [undefined, {}, "x", null];
  for (const value of values) {
    const m = new Monitor({ p: bad(value) });
    await m.refresh();
    const [s] = m.snapshots("p");
    assert.ok(s.error, String(value));
    assert.equal(s.disabled, false);
    m.stop();
  }
});

test("monitor: a rejection with text instead of an Error does not leak the text", async () => {
  const m = new Monitor({
    p: async () => {
      throw "secret-token-123";
    },
  });
  await m.refresh();
  const [s] = m.snapshots("p");
  assert.equal(s.error, "Internal read failure; last quota kept.");
  assert.ok(!(s.error ?? "").includes("secret"));
  m.stop();
});

test("monitor: a stuck collection is ended by the time limit", async () => {
  const m = new Monitor({ p: () => new Promise<Snapshot[]>(() => {}) }, 30);
  await m.refresh();
  assert.equal(m.snapshots("p")[0].error, "Query exceeded the time limit.");
  m.stop();
});

test("monitor: simultaneous refreshes reuse a single collection", async () => {
  let calls = 0;
  const m = new Monitor({
    p: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [snap("p")];
    },
  });
  await Promise.all([m.refresh(), m.refresh(), m.refresh()]);
  assert.equal(calls, 1);
  m.stop();
});

test("monitor: an empty list keeps the last read marked as old", async () => {
  let next: Snapshot[] = [snap("p")];
  const m = new Monitor({ p: async () => next });
  await m.refresh();
  next = [];
  await m.refresh();
  const [s] = m.snapshots("p");
  assert.equal(s.windows.length, 1);
  assert.equal(s.stale, true);
  assert.equal(s.error, "No reading available.");
  m.stop();
});

test("monitor: an account that disappears from the read stays visible as old", async () => {
  let next: Snapshot[] = [snap("acc1"), snap("acc2")];
  const m = new Monitor({ p: async () => next });
  await m.refresh();
  next = [snap("acc1")];
  await m.refresh();
  const all = m.snapshots("p");
  assert.equal(all.length, 2);
  const gone = all.find((s) => s.id === "acc2");
  assert.equal(gone?.stale, true);
  assert.equal(gone?.error, "Account missing from the current read.");
  m.stop();
});

test("monitor: a good read after a failure clears the error", async () => {
  let failing = true;
  const m = new Monitor({
    p: async () => {
      if (failing) throw new ReadError("Source unavailable or the query timed out.");
      return [snap("p")];
    },
  });
  await m.refresh();
  failing = false;
  await m.refresh();
  const [s] = m.snapshots("p");
  assert.equal(s.error, undefined);
  assert.notEqual(s.stale, true);
  m.stop();
});

test("monitor: start is idempotent, stop can repeat, an unknown provider gives an empty list", async () => {
  const m = new Monitor({ p: ok([snap("p")]) });
  m.start();
  m.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  m.stop();
  m.stop();
  assert.equal(m.snapshots("p").length, 1);
  assert.deepEqual(m.snapshots("does-not-exist"), []);
});

// --- panel ---

const fakeTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;

test("panel: no line goes past the width, from 1 to 60 columns", async () => {
  const m = new Monitor({
    opencode: ok([snap("opencode", {
      name: "A name far too long to fit in a truly narrow line",
      windows: [win(120, { resetsAt: NOW + 4000, duration: 18000 })],
      note: "long note ".repeat(10),
    })]),
  });
  await m.refresh();
  const panel = new QuotaPanel(m, fakeTheme);
  for (let width = 1; width <= 60; width++)
    for (const line of panel.render(width)) assert.ok(visibleWidth(line) <= width, width + ": " + line);
  m.stop();
});

test("panel: an unknown provider, object names and an error-only card render without breaking", async () => {
  const m = new Monitor({
    zzz: ok([snap("zzz", { windows: [], error: "x" })]),
    odd: ok([snap("odd", { windows: [], error: "y" })]),
  });
  await m.refresh();
  const panel = new QuotaPanel(m, fakeTheme);
  assert.ok(panel.render(40).length > 0);
  m.stop();
});

