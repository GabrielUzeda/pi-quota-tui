// Plain text of the quotas: the /quota report and the get_quotas tool. No ANSI, so the LLM reads it too.
import type { Snapshot } from "./models.ts";
import { outdated } from "./models.ts";
import { delta, forecast, health, pace, paceLabel, resetText, visible } from "./rules.ts";

/** Usage bar with the pace mark (│) when there is a reference. */
export function bar(used: number, reference: number | undefined, width: number): string {
  const filled = Math.round((used * width) / 100);
  const chars: string[] = Array.from({ length: width }, (_, i) => (i < filled ? "█" : "░"));
  if (reference !== undefined) {
    const mark = Math.min(width - 1, Math.max(0, Math.round((reference * (width - 1)) / 100)));
    chars[mark] = "│";
  }
  return chars.join("");
}

export function details(s: Snapshot, now: number): string[] {
  const stale = outdated(s, now);
  const windows = visible(s.windows);
  const lines = [s.name.toUpperCase(), health({ ...s, windows }, now)];
  if (s.updatedAt !== undefined) lines.push(`Read ${new Date(s.updatedAt * 1000).toLocaleTimeString("en-US")}`);
  if (s.error) lines.push(s.error);
  for (const w of windows) {
    lines.push(
      "",
      (w.group ? `${w.group} / ` : "") + w.label,
      `${Math.round(w.used)}% USED  |  ${Math.round(100 - w.used)}% REMAINING`,
      bar(w.used, pace(w, now, stale), 20),
      paceLabel(delta(w, now, stale)),
      resetText(w, now),
    );
    const estimate = forecast(w, now, stale);
    if (estimate) lines.push(estimate);
  }
  if (!windows.length) lines.push("No subscription data.");
  if (s.note) lines.push("", s.note);
  lines.push(`Source: ${s.source}`);
  return lines;
}

/** Optional providers: without the prerequisite they vanish instead of showing up as unconfigured. */
const OPTIONAL = new Set(["openai"]);

/** Full report; providers without configuration are listed as not configured. */
export function report(snapshots: Snapshot[], now: number): string {
  const out = ["QUOTA WATCH // AI MONITOR", "Subscription quota; not context or session cost."];
  for (const s of snapshots.filter((x) => !x.disabled && visible(x.windows).length)) out.push("", ...details(s, now));
  const off = snapshots.filter((x) => x.disabled && !OPTIONAL.has(x.id)).map((x) => x.name);
  if (off.length) out.push("", `Not configured: ${off.join(", ")}.`);
  return out.join("\n");
}

/** Sources accepted by /quota and the tool: name -> provider (undefined = all). */
const SOURCES: Record<string, string | undefined> = { all: undefined, opencode: "opencode", agy: "antigravity", commandcode: "commandcode" };
export const SOURCE_NAMES = Object.keys(SOURCES);

/** Typed name (uppercase and spaces tolerated) to the provider; never inherits from Object.prototype. */
export function resolveSource(raw: string): { valid: boolean; provider?: string } {
  const key = raw.trim().toLowerCase() || "all";
  if (!Object.hasOwn(SOURCES, key)) return { valid: false };
  return { valid: true, provider: SOURCES[key] };
}
