// Quota panel: plain ANSI list, providers side by side when they fit. No images, no animation.
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getTerminalColorMode, mixColors, rgbColor, styleText, truncateToWidth, visibleWidth, type Color, type Component } from "@earendil-works/pi-tui";
import { bar } from "./format.ts";
import { outdated } from "./models.ts";
import type { Snapshot, Window } from "./models.ts";
import { expired, pace, visible } from "./rules.ts";
import type { Monitor } from "./service.ts";

/** Balance bar width, separator between windows and gap between provider columns. */
const BAR_WIDTH = 8;
const SEP = " │ ";
const GAP = "   ";
/** Below this a provider does not fit legibly; two columns only above 2 x this. */
const MIN_COL = 30;

/** Brand colors; white uses the default text color, which follows light and dark themes. */
const BRAND: Record<string, Color | "text"> = {
  antigravity: rgbColor(66, 133, 244),
  opencode: "text",
  commandcode: "text",
  openai: rgbColor(16, 163, 127),
  claude: rgbColor(217, 119, 87),
};

function paintName(theme: Theme, s: Snapshot): string {
  const brand = BRAND[s.id];
  if (brand === "text") return theme.bold(s.name);
  if (brand === undefined) return theme.fg("accent", theme.bold(s.name));
  return styleText(s.name, { fg: brand, bold: true }, getTerminalColorMode());
}

/**
 * Bar color: with a known pace, compares usage with what should already have been spent
 * (green with slack, yellow ahead, red burning fast). Without pace, uses the balance.
 */
export function barColor(w: Window, reference: number | undefined): ThemeColor {
  if (reference === undefined) return w.used < 75 ? "accent" : w.used < 90 ? "warning" : "error";
  const over = w.used - reference;
  return over > 10 ? "error" : over > 3 ? "warning" : "success";
}

/** Time until renewal in a single unit, no extra labels. */
export function compactReset(w: Window, now: number): string {
  if (w.resetsAt === undefined) return "--";
  const seconds = w.resetsAt - now;
  if (seconds <= 0) return "0m";
  const [value, unit] = seconds >= 86400 ? [seconds / 86400, "d"]
    : seconds >= 3600 ? [seconds / 3600, "h"] : [Math.max(1, seconds / 60), "m"];
  return (w.estimated ? "~" : "") + Number(value.toFixed(1)) + unit;
}

/**
 * One window as text: group and balance bar with the pace mark, plus the time until renewal.
 * Antigravity mixes families (Gemini/Claude/Argon): the group's first word identifies the window.
 */
function windowItem(w: Window, now: number, stale: boolean, theme: Theme): string {
  const reference = pace(w, now, stale);
  const marker = bar(100 - w.used, reference === undefined ? undefined : 100 - reference, BAR_WIDTH);
  const tag = w.group ? w.group.split(/\s+/)[0] + " " : "";
  return tag + theme.fg(barColor(w, reference), marker) + " " + compactReset(w, now);
}

/** Joins the windows into lines, wrapping with an indent aligned under the first window. */
function wrap(name: string, items: string[], width: number): string[] {
  const headWidth = visibleWidth(name) + 1;
  const indent = " ".repeat(Math.min(headWidth, Math.max(0, width - 1)));
  const lines: string[] = [];
  let line = name + " ";
  let lineWidth = Math.min(headWidth, width);
  let count = 0;

  for (const item of items) {
    const sep = count ? SEP : "";
    if (count && lineWidth + visibleWidth(sep) + visibleWidth(item) > width) {
      lines.push(truncateToWidth(line, width, "…", true));
      line = indent;
      lineWidth = visibleWidth(indent);
      count = 0;
    }
    const room = width - lineWidth - (count ? visibleWidth(SEP) : 0);
    if (room <= 0) break;
    const piece = visibleWidth(item) <= room ? item : truncateToWidth(item, room, "…", true);
    if (!visibleWidth(piece)) break;
    line += (count ? SEP : "") + piece;
    lineWidth += (count ? visibleWidth(SEP) : 0) + visibleWidth(piece);
    count++;
  }

  lines.push(truncateToWidth(line, width, "…", true));
  return lines;
}

/** Lines of one provider, already at the column width. */
function providerLines(s: Snapshot, width: number, now: number, theme: Theme): string[] {
  const stale = outdated(s, now);
  // No width cut: only exhausted windows vanish, and the ones below them (see visible).
  const items = visible(s.windows).map((w) => windowItem(w, now, stale, theme));
  return wrap(paintName(theme, s), items, width);
}

/** Wait ramp: green is soon, yellow still takes a while, red is the whole cycle. */
const WAIT_GREEN = rgbColor(63, 185, 80);
const WAIT_YELLOW = rgbColor(210, 153, 34);
const WAIT_RED = rgbColor(248, 81, 73);

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Continuous wait color, no fixed marks: the closer to the ideal, the closer to green.
 * The ideal is relative to the cycle (18h of a weekly is soon; 12d of a monthly is not), and
 * without a known cycle the scale falls back to 1h..1d.
 */
export function waitColor(duration: number | undefined, left: number | undefined): Color | ThemeColor {
  if (left === undefined) return "dim";
  const bad = clamp01(duration ? (left / duration - 0.15) / 0.45 : (left - 3600) / (86400 - 3600));
  const eased = bad * bad * (3 - 2 * bad);
  return eased <= 0.5
    ? mixColors(WAIT_GREEN, WAIT_YELLOW, eased * 2, "srgb")
    : mixColors(WAIT_YELLOW, WAIT_RED, eased * 2 - 1, "srgb");
}

/**
 * Everything exhausted in a single line at the end: whoever comes back sooner shows first.
 * A provider whose only group is exhausted stays on screen, it only leaves the window list.
 */
function expiredLine(snapshots: Snapshot[], now: number, width: number, theme: Theme): string[] {
  const items = snapshots.flatMap((s) =>
    expired(s.windows).map((e) => {
      const left = e.resetsAt === undefined ? undefined : e.resetsAt - now;
      const time = compactReset({ label: "", used: 100, resetsAt: e.resetsAt, estimated: e.estimated }, now);
      const color = waitColor(e.duration, left);
      const painted = typeof color === "string" ? theme.fg(color, time) : styleText(time, { fg: color }, getTerminalColorMode());
      return {
        at: e.resetsAt ?? Infinity,
        text: paintName(theme, s) + (e.group ? " " + e.group.split(/\s+/)[0] : "") + " " + painted,
      };
    }),
  );
  if (!items.length) return [];
  items.sort((a, b) => a.at - b.at);
  const tag = styleText("Expired:", { fg: rgbColor(255, 69, 58) }, getTerminalColorMode());
  return wrap(tag, items.map((i) => i.text), width);
}

/** Widget component: providers in the dock below the editor, up to two per line. */
export class QuotaPanel implements Component {
  private readonly monitor: Monitor;
  private readonly theme: Theme;

  constructor(monitor: Monitor, theme: Theme) {
    this.monitor = monitor;
    this.theme = theme;
  }

  render(width: number): string[] {
    const now = Date.now() / 1000;
    // A provider with no window (proxy down, silent Codex, Claude without history) renders no line.
    const snapshots = this.monitor.snapshots().filter((s) => !s.disabled && s.windows.length);
    const active = snapshots.filter((s) => visible(s.windows).length);

    const cols = width >= 2 * MIN_COL + visibleWidth(GAP) ? 2 : 1;
    const colWidth = Math.floor((width - (cols - 1) * visibleWidth(GAP)) / cols);
    const lines: string[] = [];

    for (let i = 0; i < active.length; i += cols) {
      const blocks = active.slice(i, i + cols).map((s) => providerLines(s, colWidth, now, this.theme));
      const height = Math.max(...blocks.map((b) => b.length));
      for (let r = 0; r < height; r++) {
        const line = blocks.map((b) => b[r] ?? " ".repeat(colWidth)).join(GAP);
        lines.push(truncateToWidth(line, width, "…", true));
      }
    }
    lines.push(...expiredLine(snapshots, now, width, this.theme));
    if (!lines.length) return [truncateToWidth(this.theme.fg("dim", "No quota available. See the README."), width, "…", true)];
    return lines;
  }

  invalidate(): void {}
}
