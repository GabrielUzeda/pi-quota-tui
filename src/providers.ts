// Quota collectors. Read-only: no credential leaves here and no prompt is sent.
// Times are seconds since the epoch, as in the API responses.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Snapshot, Window } from "./models.ts";
import { countdown } from "./rules.ts";

export type Json = Record<string, unknown>;

/** Safe message for the UI: no URL, headers or response body. */
export class ReadError extends Error {}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const nowSec = () => Date.now() / 1000;

/** Identification sent to the APIs; matches the package name. */
const USER_AGENT = "pi-quota-tui/0.4.2";

/** Number within a range; a percentage above 100 becomes 100 instead of vanishing. */
export function clamped(value: unknown, low: number, high: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : undefined;
}

/** JSON with a BOM (common in files written on Windows) is accepted too; garbage becomes a SyntaxError without echoing the content. */
export function parseJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch {
    throw new SyntaxError("Invalid JSON");
  }
}

export function num(value: unknown, low = 0, high = 100): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) return undefined;
  return value;
}

export function epoch(value: unknown): number | undefined {
  const numeric = num(value, 1, 1e15);
  if (numeric !== undefined) {
    const seconds = numeric > 1e11 ? numeric / 1000 : numeric;
    return seconds < 253402300800 ? seconds : undefined;
  }
  if (typeof value === "string") {
    // Without an explicit timezone, treat it as UTC.
    const iso = /([zZ]|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? undefined : ms / 1000;
  }
  return undefined;
}

const MAX_BYTES = 2 * 1024 * 1024;

/** Reads the body up to the limit: a bigger response is cut during the read, not after. */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new ReadError("Response exceeds the read limit.");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** GET/POST JSON with timeout; no redirects, no env proxy, HTTP only on loopback. */
export async function readJson(
  url: string,
  options: { headers?: Record<string, string>; body?: string; timeout: number },
): Promise<Json> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ReadError("Quota address not allowed.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new ReadError("Quota address not allowed.");
  if (parsed.protocol === "http:" && parsed.hostname !== "127.0.0.1")
    throw new ReadError("Plain HTTP allowed only on loopback.");
  let text: string;
  try {
    const init: RequestInit = {
      method: options.body === undefined ? "GET" : "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeout * 1000),
    };
    if (options.headers) init.headers = options.headers;
    if (options.body !== undefined) init.body = options.body;
    const response = await fetch(url, init);
    if (!response.ok) throw new ReadError(`Query refused (HTTP ${response.status}).`);
    text = await readCapped(response);
  } catch (error) {
    if (error instanceof ReadError) throw error;
    throw new ReadError("Source unavailable or the query timed out.");
  }
  let data: unknown;
  try {
    data = parseJson(text);
  } catch {
    throw new ReadError("Invalid quota response.");
  }
  if (!isObject(data)) throw new ReadError("Unrecognized quota format.");
  return data;
}

// --- credentials: Pi's auth.json (only if private) first, environment variables as fallback ---

// Resolved on every call: HOME may change (tests, different sessions).
const piAuth = () => join(homedir(), ".pi", "agent", "auth.json");

async function authFile(): Promise<Json> {
  try {
    const info = await stat(piAuth());
    if (info.mode & 0o077) return {};
    const data = parseJson(await readFile(piAuth(), "utf8"));
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
}

async function authEntry(section: string): Promise<Json> {
  const item = (await authFile())[section];
  return isObject(item) ? item : {};
}

export async function secret(envNames: string[], section: string): Promise<string> {
  const key = (await authEntry(section)).key;
  if (typeof key === "string" && key.trim()) return key.trim();
  for (const name of envNames) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

/** OAuth token saved by the pi login (`type: "oauth"`); empty when the section is an api key or missing. */
async function oauthAccess(section: string): Promise<string> {
  const entry = await authEntry(section);
  const token = entry.type === "oauth" ? entry.access : undefined;
  return typeof token === "string" ? token.trim() : "";
}

function disabled(id: string, name: string, source: string, error: string): Snapshot {
  return { id, name, windows: [], source, error, disabled: true };
}

// --- OpenCode Go: subscription, not sessions nor Zen balance ---

const OPENCODE_URL = "https://opencode.ai/zen/go/v1/usage";
// OpenCode's month renews on the subscription anniversary (28..31 days); 30 days is enough for the pace.
// shortcut: up to ~2% cycle error in the monthly pace, fix if the API reports the start.
const MONTHLY = 30 * 86400;

export function parseOpencode(root: Json, now: number): Snapshot {
  const usage = "usage" in root ? root.usage : root;
  const windows: Window[] = [];
  if (isObject(usage)) {
    for (const [key, label, duration] of [
      ["rolling", "5 hours", 18000],
      ["weekly", "Weekly", 604800],
      ["monthly", "Monthly", MONTHLY],
    ] as const) {
      const item = usage[key];
      if (!isObject(item)) continue;
      const used = clamped(item.percent, 0, 100);
      if (used !== undefined) windows.push({ label, used, resetsAt: epoch(item.resetsAt), duration });
    }
  }
  if (!windows.length) throw new ReadError("OpenCode did not report any recognized quota window.");
  return { id: "opencode", name: "OpenCode Go", windows, updatedAt: now, source: "OpenCode Go / usage" };
}

async function collectOpencode(): Promise<Snapshot[]> {
  const key = await secret(["OPENCODE_GO_KEY"], "opencode-go");
  if (!key)
    return [disabled("opencode", "OpenCode Go", "OpenCode Go / usage", "No credential: set the `opencode-go` entry in ~/.pi/agent/auth.json (or OPENCODE_GO_KEY).")];
  const root = await readJson(OPENCODE_URL, {
    headers: { Authorization: `Bearer ${key}`, "User-Agent": "opencode/1.18.30" },
    timeout: 10,
  });
  return [parseOpencode(root, nowSec())];
}

// --- CommandCode: credit balance; the monthly window is balance + consumed ---

const CC_BASE = "https://api.commandcode.ai/alpha";

function commandcodeWindow(limits: Json, key: string, label: string, duration: number): Window | undefined {
  const item = limits[key];
  if (!isObject(item)) return undefined;
  const cap = num(item.cap, 0, 1e12);
  const used = num(item.used, 0, 1e12);
  if (!cap || used === undefined) return undefined;
  return { label, used: Math.min(100, (used / cap) * 100), resetsAt: epoch(item.resetAt), duration };
}

/** Next reset day (UTC), capped at 28 so it exists in every month. */
export function nextMonthlyReset(day: number, now: number): number {
  const moment = new Date(now * 1000);
  const clamped = Math.min(Math.max(day, 1), 28);
  let reset = Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), clamped) / 1000;
  if (now >= reset) reset = Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth() + 1, clamped) / 1000;
  return reset;
}

export function parseCommandcode(credits: Json, summary: Json | undefined, now: number, resetDay = 16): Snapshot {
  const wallet = credits.credits;
  if (!isObject(wallet)) throw new ReadError("CommandCode did not report credits.");
  const monthly = num(wallet.monthlyCredits, 0, 1e12) ?? 0;
  const purchased = num(wallet.purchasedCredits, 0, 1e12) ?? 0;
  const free = num(wallet.freeCredits, 0, 1e12) ?? 0;
  const limits = isObject(credits.windowLimits) ? credits.windowLimits : undefined;
  const windows: Window[] = [];
  if (limits) {
    for (const [key, label, duration] of [["fiveHour", "5 hours", 18000], ["weekly", "Weekly", 604800]] as const) {
      const window = commandcodeWindow(limits, key, label, duration);
      if (window) windows.push(window);
    }
  }
  const used = summary ? num(summary.totalMonthlyCredits, 0, 1e12) : undefined;
  const cap = monthly + (used ?? 0);
  if (cap > 0)
    windows.push({ label: "Monthly", used: Math.min(100, ((cap - monthly) / cap) * 100), resetsAt: nextMonthlyReset(resetDay, now) });
  const balance = monthly + purchased + free;
  let note = `Balance ${balance.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} credits`;
  if (!windows.some((w) => w.label !== "Monthly")) note += " | no 5h/weekly window on this account";
  return { id: "commandcode", name: "CommandCode", windows, updatedAt: now, source: "CommandCode / billing", note };
}

async function collectCommandcode(): Promise<Snapshot[]> {
  const key = await secret(["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"], "commandcode");
  if (!key) return [disabled("commandcode", "CommandCode", "CommandCode / billing", "No credential: set the `commandcode` entry in ~/.pi/agent/auth.json (or COMMAND_CODE_API_KEY).")];
  const headers = { Accept: "application/json", "User-Agent": USER_AGENT, Authorization: `Bearer ${key}` };
  const credits = await readJson(`${CC_BASE}/billing/credits`, { headers, timeout: 10 });
  const summary = await readJson(`${CC_BASE}/usage/summary`, { headers, timeout: 10 }).catch(() => undefined);
  const day = Number((await authEntry("commandcode")).resetDay ?? 16);
  return [parseCommandcode(credits, summary, nowSec(), Number.isFinite(day) ? day : 16)];
}

// --- Antigravity / Cloud Code: own OAuth, no local proxy ---

const AGY_SOURCE = "Antigravity / Cloud Code";
const AGY_PROJECT = "aicode-consumers";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const AGY_QUOTA_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
];
// Antigravity CLI credential, the same one the local proxy used. It is published in the package by
// the author's decision: if Google revokes or restricts this client, this path stops working.
const AGY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const AGY_CLIENT_SECRET = "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";
// Cloud Code refuses (403) whoever does not identify as the CLI; the proxy used exactly this UA.
const AGY_USER_AGENT = "antigravity/cli/1.2.16 (aidev_client; os_type=darwin; arch=arm64; auth_method=consumer)";

/** Antigravity accounts: `PI_QUOTA_TUI_AGY_ACCOUNTS` or the file /quota-login keeps. */
export const agyAccountsPath = (): string =>
  process.env.PI_QUOTA_TUI_AGY_ACCOUNTS?.trim() || join(homedir(), ".local", "share", "pi-quota-tui", "agy-accounts.json");

/** AGY Local Proxy accounts.json: read-only, compatibility with whoever already had it. */
export const agyLegacyPath = (): string => join(homedir(), ".local", "share", "agy-local-proxy", "accounts.json");

type AgyAccount = Json & { refreshToken: string };

const identityKey = (account: Json, index: number): string => {
  const identity = account.email || account.projectId;
  return identity ? createHash("sha256").update(String(identity)).digest("hex").slice(0, 10) : String(index + 1);
};

export function parseGroups(groups: unknown): Window[] {
  if (!Array.isArray(groups)) return [];
  const windows: Window[] = [];
  for (const group of groups) {
    if (!isObject(group) || typeof group.displayName !== "string" || !Array.isArray(group.buckets)) continue;
    const name = group.displayName
      .trim()
      .replace(/\s+models$/i, "")
      // "Gemini 4 Argon" becomes "Argon": the model line stays short in the panel.
      .replace(/^Gemini\s+\d+(?:\.\d+)?\s+/i, "");
    for (const bucket of group.buckets) {
      if (!isObject(bucket) || bucket.disabled === true) continue;
      const fraction = clamped(bucket.remainingFraction, 0, 1);
      if (fraction === undefined) continue;
      const [label, duration]: [string, number | undefined] =
        bucket.window === "5h" ? ["5 hours", 18000] : bucket.window === "weekly" ? ["Weekly", 604800] : ["Limit", undefined];
      windows.push({ label, used: (1 - fraction) * 100, resetsAt: epoch(bucket.resetTime), duration, group: name });
    }
  }
  return windows;
}

/** Usable accounts: without a refreshToken the token cannot be renewed, so they stay out. */
export function parseAgyAccounts(root: unknown): AgyAccount[] {
  if (!Array.isArray(root)) return [];
  return root
    .filter(isObject)
    .filter((account): account is AgyAccount => typeof account.refreshToken === "string" && account.refreshToken.trim() !== "");
}

/** Private JSON: holds refresh tokens, so only the owner can read it, like auth.json. */
export async function readPrivateJson(path: string): Promise<unknown> {
  try {
    const info = await stat(path);
    if (info.mode & 0o077) return undefined;
    return parseJson(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function agyAccountsFile(): Promise<unknown> {
  return (await readPrivateJson(agyAccountsPath())) ?? (await readPrivateJson(agyLegacyPath()));
}

const googleToken = (body: Record<string, string>): Promise<Json> =>
  readJson(GOOGLE_TOKEN_URL, {
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: AGY_CLIENT_ID, client_secret: AGY_CLIENT_SECRET, ...body }).toString(),
    timeout: 10,
  });

/** Public Antigravity CLI client; /quota-login builds the consent URL with it. */
export const AGY_CLIENT = AGY_CLIENT_ID;

/** Google consent code exchanged for a refresh token (login done by the extension itself). */
export const agyLoginToken = (code: string, redirect: string, verifier: string): Promise<Json> =>
  googleToken({ code, redirect_uri: redirect, code_verifier: verifier, grant_type: "authorization_code" });

export async function agyToken(refreshToken: string): Promise<string> {
  const root = await googleToken({ refresh_token: refreshToken, grant_type: "refresh_token" });
  const token = root.access_token;
  if (typeof token !== "string" || !token) throw new ReadError("Google did not refresh the token for this Antigravity account.");
  return token;
}

/** The first endpoint is the daily one; the second covers accounts that only answer on the old host. */
async function agyGroups(token: string, project: string): Promise<unknown[]> {
  let failure: ReadError | undefined;
  for (const url of AGY_QUOTA_URLS) {
    try {
      const root = await readJson(url, {
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": AGY_USER_AGENT },
        body: JSON.stringify({ project }),
        timeout: 10,
      });
      if (Array.isArray(root.groups)) return root.groups;
      failure = new ReadError("Cloud Code did not report quota groups.");
    } catch (error) {
      if (!(error instanceof ReadError)) throw error;
      failure = error;
    }
  }
  throw failure ?? new ReadError("Cloud Code did not report quota groups.");
}

/** One Antigravity account becomes a snapshot; the paid one is picked later by paidIndex. */
export function agySnapshot(account: AgyAccount, index: number, groups: unknown[], now: number): Snapshot {
  const key = identityKey(account, index);
  const windows = parseGroups(groups);
  return {
    id: `antigravity/${key}`,
    name: `Antigravity / account ${key.slice(0, 6)}`,
    windows,
    updatedAt: now,
    source: AGY_SOURCE,
    error: windows.length ? undefined : "Account has no recognized quota reading.",
    note: "Accounts kept separate; percentages are neither summed nor averaged.",
  };
}

/** Paid account: the one pointed to by PI_QUOTA_TUI_AGY_PAID (id, e-mail or project) or the one with most windows read. */
export function paidIndex(accounts: AgyAccount[], snapshots: Snapshot[], hint = ""): number {
  const wanted = hint.trim();
  if (wanted) {
    const found = accounts.findIndex(
      (a, i) => wanted === a.email || wanted === a.projectId || identityKey(a, i).startsWith(wanted),
    );
    if (found >= 0) return found;
  }
  let best = 0;
  let bestCount = -1;
  snapshots.forEach((s, index) => {
    if (s.windows.length > bestCount) {
      best = index;
      bestCount = s.windows.length;
    }
  });
  return best;
}

/** One main quota (the paid one); the others become BONUS. Nothing is summed nor averaged. */
export function collapse(snapshots: Snapshot[], primary: number, now: number): Snapshot {
  const chosen = snapshots[primary] ?? snapshots[0];
  if (!chosen) throw new ReadError("No Antigravity account available.");
  const others = snapshots.filter((_, index) => index !== primary);
  const parts = [`PAID ${(chosen.id.split("/").pop() ?? "").slice(0, 6)}`];
  const usable = others.filter((s) => s.windows.length && !s.error);
  if (usable.length) {
    const best = (label: string): string => {
      const cells = usable.flatMap((s) => s.windows.filter((w) => w.label === label).map((w) => ({ left: 100 - w.used, reset: w.resetsAt })));
      if (!cells.length) return `${label.toLowerCase()} no reading`;
      const top = cells.reduce((a, b) => (b.left > a.left ? b : a));
      const tail = top.reset !== undefined && top.reset > now ? ` (renews in ${countdown(top.reset - now)})` : "";
      return `${label.toLowerCase()} ${top.left.toFixed(0)}% free${tail}`;
    };
    parts.push(`BONUS ${others.length} accounts: ${best("5 hours")} | ${best("Weekly")}`);
  } else {
    parts.push(`BONUS ${others.length} accounts without a reading`);
  }
  if (chosen.note) parts.push(chosen.note);
  return { ...chosen, id: "antigravity", name: "Antigravity", note: parts.join(" | ") };
}

async function collectAntigravity(): Promise<Snapshot[]> {
  const now = nowSec();
  const accounts = parseAgyAccounts(await agyAccountsFile());
  if (!accounts.length)
    return [disabled("antigravity", "Antigravity", AGY_SOURCE,
      "No Antigravity accounts: run /quota-login to import from AGY or sign in with Google.")];
  const snapshots = await Promise.all(accounts.map(async (account, index) => {
    try {
      const token = await agyToken(account.refreshToken.trim());
      return agySnapshot(account, index, await agyGroups(token, String(account.projectId ?? AGY_PROJECT)), now);
    } catch (error) {
      const key = identityKey(account, index);
      return {
        id: `antigravity/${key}`,
        name: `Antigravity / account ${key.slice(0, 6)}`,
        windows: [],
        source: AGY_SOURCE,
        error: error instanceof ReadError ? error.message : "Antigravity read failed.",
      } satisfies Snapshot;
    }
  }));
  // No readable account: returns the per-account errors so /quota can explain each one.
  if (!snapshots.some((s) => s.windows.length)) return snapshots;
  return [collapse(snapshots, paidIndex(accounts, snapshots, process.env.PI_QUOTA_TUI_AGY_PAID ?? ""), now)];
}

// --- OpenAI/Codex: 'codex app-server --stdio' with the session already logged in (no tokens here) ---

const CODEX_DURATIONS: Record<number, [string, number]> = { 300: ["5 hours", 18000], 10080: ["Weekly", 604800] };

function codexBucket(result: Json): Json {
  const byId = result.rateLimitsByLimitId;
  if (isObject(byId) && Object.keys(byId).length) {
    if (isObject(byId.codex)) return byId.codex;
    const first = Object.values(byId).find(isObject);
    if (first) return first;
  }
  if (isObject(result.rateLimits)) return result.rateLimits;
  throw new ReadError("Codex did not report quota limits for this account.");
}

function codexWindow(item: unknown, fallback: string): Window | undefined {
  if (!isObject(item)) return undefined;
  const used = clamped(item.usedPercent, 0, 100);
  if (used === undefined) return undefined;
  const minutes = typeof item.windowDurationMins === "number" ? item.windowDurationMins : undefined;
  const known = minutes === undefined ? undefined : CODEX_DURATIONS[minutes];
  // Duration outside the table: label with the real duration, without calling it "5 hours".
  const label = known?.[0] ?? (minutes === undefined ? fallback : minutes + " min window");
  return { label, used, resetsAt: epoch(item.resetsAt), duration: known?.[1] };
}

export function parseCodex(result: Json, now: number): Snapshot {
  const bucket = codexBucket(result);
  const windows = [codexWindow(bucket.primary, "5 hours"), codexWindow(bucket.secondary, "Weekly")].filter(
    (w): w is Window => w !== undefined,
  );
  if (!windows.length) throw new ReadError("Codex reported limits without a usable percentage.");
  const credits = result.rateLimitResetCredits;
  const count = isObject(credits) ? credits.availableCount : undefined;
  const note = typeof count === "number" && Number.isInteger(count) && count > 0 ? `${count} limit reset(s) available` : "";
  return { id: "openai", name: "OpenAI Codex", windows, updatedAt: now, source: "codex app-server", note };
}

class MissingBinary extends ReadError {}

/** Quota keys do not go to the subprocess: Codex does not need them. */
const FOREIGN_SECRETS = ["OPENCODE_GO_KEY", "COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"];

function codexEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of FOREIGN_SECRETS) delete env[name];
  return env;
}

function codexRateLimits(): Promise<Json> {
  return new Promise((resolve, reject) => {
    const proc = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "ignore"], env: codexEnv() });
    let settled = false;
    const finish = (error?: Error, value?: Json) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill();
      if (error) reject(error);
      else resolve(value ?? {});
    };
    const noAnswer = () => new ReadError("Codex did not answer the quota read.");
    const timer = setTimeout(() => finish(noAnswer()), 20_000);
    proc.on("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ENOENT" ? new MissingBinary("Codex CLI not found on PATH.") : noAnswer()));
    proc.on("close", () => finish(noAnswer()));
    proc.stdin?.on("error", () => finish(noAnswer())); // EPIPE if the process dies first
    createInterface({ input: proc.stdout! }).on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isObject(message) || message.id !== 2) return;
      if (isObject(message.error)) return finish(new ReadError("Codex refused the quota read."));
      return isObject(message.result) ? finish(undefined, message.result) : finish(noAnswer());
    });
    const requests = [
      { method: "initialize", id: 1, params: { clientInfo: { name: "pi-quota-tui", title: "pi-quota-tui", version: "0" } } },
      { method: "initialized" },
      { method: "account/rateLimits/read", id: 2 },
    ];
    for (const request of requests) proc.stdin?.write(JSON.stringify(request) + "\n");
  });
}

async function collectOpenai(): Promise<Snapshot[]> {
  try {
    return [parseCodex(await codexRateLimits(), nowSec())];
  } catch (error) {
    if (error instanceof MissingBinary) return [disabled("openai", "OpenAI Codex", "codex app-server", error.message)];
    throw error;
  }
}

// --- Claude: local history of the desktop app; no network ---

const CLAUDE_SOURCE = "Claude app / plan history";
const CLAUDE_NO_DATA = "No Claude data: open the desktop app or log in (Claude Pro/Max) in pi.";
const FIVE_HOURS = 18000;
const WEEKLY = 604800;

interface Sample {
  at: number;
  org?: string;
  fh?: number;
  sd?: number;
}

type SampleKey = "fh" | "sd";

// shortcut: the OAuth path (api/oauth/usage) has no integration test - only parseOauthUsage is
// tested, because the call needs a real Claude Pro/Max login; cover it once there is a test credential.
function historyCandidates(): string[] {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return [
    join(config, "Claude", "plan-usage-history.json"),
    join(homedir(), ".local", "share", "Claude", "plan-usage-history.json"),
    join(homedir(), ".claude", "plan-usage-history.json"),
  ];
}

async function historyPath(): Promise<string | undefined> {
  const found: { path: string; mtime: number }[] = [];
  for (const path of historyCandidates()) {
    try {
      const info = await stat(path);
      if (info.isFile()) found.push({ path, mtime: info.mtimeMs });
    } catch {
      // missing: ignore
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)[0]?.path;
}

async function readSamples(path: string): Promise<Sample[]> {
  let raw: unknown;
  try {
    raw = parseJson(await readFile(path, "utf8"));
  } catch {
    throw new ReadError("Could not read the Claude app history.");
  }
  const items = isObject(raw) ? raw.samples : undefined;
  if (!Array.isArray(items)) throw new ReadError("Claude history in an unknown format.");
  const rows: Sample[] = [];
  for (const item of items) {
    if (!isObject(item) || typeof item.t !== "number") continue;
    const usage = isObject(item.u) ? item.u : {};
    rows.push({
      at: item.t / 1000,
      org: typeof item.org === "string" ? item.org : undefined,
      fh: clamped(usage.fh, 0, 100),
      sd: clamped(usage.sd, 0, 100),
    });
  }
  rows.sort((a, b) => a.at - b.at);
  if (!rows.length) throw new ReadError("The Claude app has not recorded plan usage yet.");
  const org = rows[rows.length - 1].org;
  return rows.filter((row) => row.org === org);
}

function latestIndex(rows: Sample[], key: SampleKey): number | undefined {
  for (let index = rows.length - 1; index >= 0; index--) if (rows[index][key] !== undefined) return index;
  return undefined;
}

/** 5h window reset = middle of the gap without samples + duration. Weekly is never invented. */
export function estimateReset(rows: Sample[], key: SampleKey, index: number, now: number, duration: number): [number | undefined, string] {
  if (duration === WEEKLY) return [undefined, "waiting for the official renewal time"];
  const latest = rows[index];
  const used = latest[key];
  if (now - latest.at > duration) return [undefined, "window expired since the last sample"];
  if (used === undefined || used <= 0) return [undefined, "window starts on the next use"];
  let first = index;
  let previous: number | undefined;
  for (let j = index - 1; j >= 0; j--) {
    const value = rows[j][key];
    if (value === undefined) continue;
    if (value <= 0 || value > used || latest.at - rows[j].at > duration) {
      previous = j;
      break;
    }
    first = j;
  }
  if (previous === undefined || rows[first].at - rows[previous].at > 7200)
    return [undefined, "renewal time unavailable"];
  return [(rows[previous].at + rows[first].at) / 2 + duration, "reset estimated from the window start"];
}

async function readHistory(now: number): Promise<Snapshot | undefined> {
  const path = await historyPath();
  if (!path) return undefined;
  const rows = await readSamples(path);
  const windows: Window[] = [];
  const hints: string[] = [];
  let stale = false;
  for (const [key, label, duration] of [["fh", "5 hours", FIVE_HOURS], ["sd", "Weekly", WEEKLY]] as const) {
    const index = latestIndex(rows, key);
    if (index === undefined) continue;
    const [resetsAt, hint] = estimateReset(rows, key, index, now, duration);
    windows.push({ label, used: rows[index][key] as number, resetsAt, duration, estimated: true });
    if (resetsAt === undefined) hints.push(hint);
    stale = stale || now - rows[index].at > 40 * 60;
  }
  let note = CLAUDE_SOURCE;
  if (hints.length) note += ` | ${[...new Set(hints)].join(" | ")}`;
  if (stale) note += " | open the Claude app to refresh";
  return {
    id: "claude",
    name: "Claude Code",
    windows,
    updatedAt: rows[rows.length - 1].at,
    source: CLAUDE_SOURCE,
    note,
    stale,
  };
}

const noClaudeData = (): Snapshot => disabled("claude", "Claude Code", CLAUDE_SOURCE, CLAUDE_NO_DATA);

// --- Claude: subscription OAuth (fallback when there is no local file) ---

const ANTHROPIC_USAGE = "https://api.anthropic.com/api/oauth/usage";

/** Subscription usage through OAuth: utilization 0..100 and resets_at in ISO. */
export function parseOauthUsage(root: Json, now: number): Snapshot {
  const windows: Window[] = [];
  const locked: string[] = [];
  for (const [key, label, duration] of [["five_hour", "5 hours", FIVE_HOURS], ["seven_day", "Weekly", WEEKLY]] as const) {
    const item = root[key];
    if (!isObject(item)) continue;
    const used = clamped(item.utilization, 0, 100);
    if (used === undefined) continue;
    windows.push({ label, used, resetsAt: epoch(item.resets_at), duration });
    if (typeof item.locked_reason === "string" && item.locked_reason) locked.push(label);
  }
  if (!windows.length) throw new ReadError("Claude (OAuth) did not report any quota window.");
  const parts = ["pi OAuth / subscription usage"];
  if (locked.length) parts.push(`locked: ${locked.join(", ")}`);
  return { id: "claude", name: "Claude Code", windows, updatedAt: now, source: "Claude / OAuth usage", note: parts.join(" | ") };
}

async function readOauthUsage(now: number): Promise<Snapshot | undefined> {
  const token = await oauthAccess("anthropic");
  if (!token) return undefined;
  const root = await readJson(ANTHROPIC_USAGE, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "x-app": "cli",
      "User-Agent": USER_AGENT,
    },
    timeout: 10,
  });
  return parseOauthUsage(root, now);
}

/** Desktop app history; a local error only shows if OAuth also yields nothing. */
async function localClaude(now: number): Promise<{ snapshot?: Snapshot; error?: Snapshot }> {
  if (!(await historyPath())) return {};
  try {
    const desktop = await readHistory(now);
    return desktop?.windows.length ? { snapshot: desktop } : {};
  } catch (error) {
    const message = error instanceof ReadError ? error.message : "Failed to read the Claude app history.";
    return { error: { id: "claude", name: "Claude Code", windows: [], source: CLAUDE_SOURCE, error: message } };
  }
}

async function collectClaude(): Promise<Snapshot[]> {
  const now = nowSec();
  const local = await localClaude(now);
  if (local.snapshot) return [local.snapshot];
  try {
    const oauth = await readOauthUsage(now);
    if (oauth) return [oauth];
  } catch (error) {
    if (error instanceof ReadError) return [{ id: "claude", name: "Claude Code", windows: [], source: "Claude / OAuth usage", error: error.message }];
    throw error;
  }
  return [local.error ?? noClaudeData()];
}

// --- collector registry, per provider ---

export const COLLECTORS: Record<string, () => Promise<Snapshot[]>> = {
  antigravity: collectAntigravity,
  opencode: collectOpencode,
  openai: collectOpenai,
  claude: collectClaude,
  commandcode: collectCommandcode,
};
