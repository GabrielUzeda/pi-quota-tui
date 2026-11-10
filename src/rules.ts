// Pace and health compare usage with the time left until renewal.
import { outdated, type Snapshot, type Window } from "./models.ts";

/** Hierarchy monthly > weekly > 5h: exhausting the one above makes the ones below useless. */
const RANKS: Record<string, number> = { Monthly: 3, Weekly: 2, "5 hours": 1 };

/**
 * Windows worth showing: nothing below an exhausted window of the same group shows up.
 * An unknown rank ("Limit", AGY families) is never hidden and never exhausts anything.
 */
export function visible(windows: Window[]): Window[] {
  const dead = new Map<string, number>();
  for (const w of windows) {
    const rank = RANKS[w.label];
    // Threshold for what the screen shows as 0% left: the API returns 99.96, not exactly 100.
    if (Math.round(w.used) < 100 || rank === undefined) continue;
    const key = w.group ?? "";
    dead.set(key, Math.max(dead.get(key) ?? 0, rank));
  }
  if (!dead.size) return windows;
  return windows.filter((w) => (RANKS[w.label] ?? Infinity) > (dead.get(w.group ?? "") ?? 0));
}

/**
 * What is exhausted and when it comes back: per group, the highest-ranked window wins (the one
 * that blocks the ones below), and on a tie the one that renews last. Groups with an unknown
 * rank never exhaust.
 */
export interface Expired {
  group?: string;
  resetsAt?: number;
  /** Cycle seconds; calibrates whether the wait is long or soon. */
  duration?: number;
  estimated?: boolean;
}

export function expired(windows: Window[]): Expired[] {
  const dead = new Map<string, { rank: number; resetsAt?: number; duration?: number; estimated?: boolean }>();
  for (const w of windows) {
    const rank = RANKS[w.label];
    if (rank === undefined || Math.round(w.used) < 100) continue;
    const key = w.group ?? "";
    const prev = dead.get(key);
    const later = (w.resetsAt ?? 0) > (prev?.resetsAt ?? 0);
    if (!prev || rank > prev.rank || (rank === prev.rank && later))
      dead.set(key, { rank, resetsAt: w.resetsAt, duration: w.duration, estimated: w.estimated });
  }
  return [...dead].map(([group, d]) => ({ group: group || undefined, resetsAt: d.resetsAt, duration: d.duration, estimated: d.estimated }));
}

export function pace(w: Window, now: number, stale = false): number | undefined {
  if (stale || w.resetsAt === undefined || w.duration === undefined) return undefined;
  const left = w.resetsAt - now;
  if (!(left > 0 && left <= w.duration)) return undefined;
  return (1 - left / w.duration) * 100;
}

export function delta(w: Window, now: number, stale = false): number | undefined {
  const reference = pace(w, now, stale);
  return reference === undefined ? undefined : w.used - reference;
}

export function paceLabel(value: number | undefined): string {
  if (value === undefined) return "PACE UNAVAILABLE";
  if (value > 3) return `${Math.round(value)}% AHEAD`;
  if (value < -3) return `${Math.round(-value)}% SLACK`;
  return "ON PACE";
}

export function forecast(w: Window, now: number, stale = false): string {
  const reference = pace(w, now, stale);
  if (reference === undefined || w.duration === undefined || reference < 2 || w.used < 1) return "";
  if (w.used >= 100) return "QUOTA EXHAUSTED; waiting for renewal";
  const projected = (w.used * 100) / reference;
  if (projected > 100) {
    const elapsed = (w.duration * reference) / 100;
    const left = Math.max(0, elapsed * (100 / w.used - 1));
    return `~runs out in ${countdown(left)} before renewal`;
  }
  return `~${Math.max(0, 100 - projected).toFixed(0)}% left at renewal`;
}

export function countdown(seconds: number): string {
  const minutes = Math.max(1, Math.floor((seconds + 59) / 60));
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}min`;
  return `${minutes}min`;
}

export function resetText(w: Window, now: number): string {
  if (w.resetsAt === undefined) return "RESETS: time unavailable";
  if (w.resetsAt <= now) return "WAITING FOR NEW DATA";
  return "RESETS IN " + (w.estimated ? "~" : "") + countdown(w.resetsAt - now);
}

/** Health label of the quota. */
export function health(s: Snapshot, now: number): string {
  if (!s.windows.length) return "NO SIGNAL";
  if (outdated(s, now)) return "OUTDATED";
  // Balance left relative to the fraction of the cycle still to be covered.
  const coverage = Math.min(...s.windows.map((w) => {
    const remaining = (100 - w.used) / 100;
    const elapsed = pace(w, now);
    // Without a known cycle, uses absolute balance: 60/50/37.5% as bands.
    return remaining / (elapsed === undefined ? 0.5 : 1 - elapsed / 100);
  }));
  if (coverage <= 0.75) return "LOW";
  if (coverage < 1) return "TIGHT";
  if (coverage > 1.2) return "SLACK";
  return "ON TRACK";
}
