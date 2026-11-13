// User preferences in ~/.pi/agent/pi-quota-tui.json: hand-editable, and /quota-config writes it.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { COLLECTORS, parseJson } from "./providers.ts";

/** Provider ids accepted in hiddenProviders. */
export const PROVIDER_IDS = Object.keys(COLLECTORS);

export interface Config {
  /** Providers neither collected nor shown. */
  hiddenProviders: string[];
  refreshSeconds: number;
  showOnStart: boolean;
  placement: "belowEditor" | "aboveEditor";
  barWidth: number;
  /** Most providers per panel row. */
  columns: 1 | 2;
  showExpired: boolean;
}

export const DEFAULTS: Readonly<Config> = Object.freeze({
  hiddenProviders: [],
  refreshSeconds: 120,
  showOnStart: true,
  placement: "belowEditor",
  barWidth: 8,
  columns: 2,
  showExpired: true,
});

/** Inclusive ranges of the numeric fields, shared with the /quota-config prompts. */
export const LIMITS = { refreshSeconds: [30, 86400], barWidth: [4, 30] } as const;

// Resolved on every call: pi's agent dir follows PI_CODING_AGENT_DIR and HOME, which may change.
export const configPath = (): string => join(getAgentDir(), "pi-quota-tui.json");

const int = (value: unknown, [low, high]: readonly [number, number], fallback: number): number =>
  Number.isInteger(value) && (value as number) >= low && (value as number) <= high ? (value as number) : fallback;
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

/** Keeps each valid field; a missing, wrong or out-of-range field falls back to its default. */
export function parseConfig(raw: unknown): Config {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const hidden = Array.isArray(o.hiddenProviders)
    ? [...new Set(o.hiddenProviders.filter((id): id is string => PROVIDER_IDS.includes(id as string)))]
    : [];
  return {
    hiddenProviders: hidden,
    refreshSeconds: int(o.refreshSeconds, LIMITS.refreshSeconds, DEFAULTS.refreshSeconds),
    showOnStart: bool(o.showOnStart, DEFAULTS.showOnStart),
    placement: o.placement === "aboveEditor" || o.placement === "belowEditor" ? o.placement : DEFAULTS.placement,
    barWidth: int(o.barWidth, LIMITS.barWidth, DEFAULTS.barWidth),
    columns: o.columns === 1 || o.columns === 2 ? o.columns : DEFAULTS.columns,
    showExpired: bool(o.showExpired, DEFAULTS.showExpired),
  };
}

/** Missing file means defaults; an unreadable or invalid one too, plus a message for the user. */
export async function loadConfig(path = configPath()): Promise<{ config: Config; error?: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: parseConfig({}) };
    return { config: parseConfig({}), error: "Could not read " + path + "; using defaults." };
  }
  try {
    return { config: parseConfig(parseJson(text)) };
  } catch {
    return { config: parseConfig({}), error: "Invalid JSON in " + path + "; using defaults." };
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Temp file plus rename: a crash mid-write never leaves a half-written config.
 * Keys this version does not know survive; a hand-broken file is copied to .bak instead of lost.
 */
export async function saveConfig(config: Config, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const old = await readFile(path, "utf8").catch(() => undefined);
  let previous: unknown = {};
  try {
    if (old !== undefined) previous = parseJson(old);
  } catch {
    previous = undefined;
  }
  if (old !== undefined && !isRecord(previous)) await writeFile(path + ".bak", old);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ ...(isRecord(previous) ? previous : {}), ...config }, null, 2) + "\n");
  await rename(temp, path);
}
