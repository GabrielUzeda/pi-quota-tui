// /quota-config: edits a copy of the preferences through pi's select/input dialogs.
import { DEFAULTS, LIMITS, PROVIDER_IDS, configPath, type Config } from "./config.ts";
import { NAMES } from "./service.ts";

/** The slice of ctx.ui the menu uses; tests script it. */
export interface MenuUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

const SAVE = "Save";
const DONE = "Done";

/** Returns the edited preferences on Save, undefined on Esc. The input is never mutated. */
export async function editConfig(ui: MenuUI, start: Config): Promise<Config | undefined> {
  const draft: Config = { ...start, hiddenProviders: [...start.hiddenProviders] };
  const onOff = (value: boolean) => (value ? "shown" : "hidden");
  for (;;) {
    const visible = PROVIDER_IDS.filter((id) => !draft.hiddenProviders.includes(id));
    const entries: [string, () => Promise<void> | void][] = [
      ["Providers: " + (visible.map((id) => NAMES[id] ?? id).join(", ") || "none"), () => pickProviders(ui, draft)],
      ["Refresh every: " + draft.refreshSeconds + "s", async () => {
        draft.refreshSeconds = await askInt(ui, "Refresh interval in seconds", LIMITS.refreshSeconds, draft.refreshSeconds);
      }],
      ["Panel on start: " + onOff(draft.showOnStart), () => void (draft.showOnStart = !draft.showOnStart)],
      ["Panel position: " + (draft.placement === "belowEditor" ? "below" : "above") + " the editor", () =>
        void (draft.placement = draft.placement === "belowEditor" ? "aboveEditor" : "belowEditor")],
      ["Bar width: " + draft.barWidth, async () => {
        draft.barWidth = await askInt(ui, "Bar width in characters", LIMITS.barWidth, draft.barWidth);
      }],
      ["Providers per row: up to " + draft.columns, () => void (draft.columns = draft.columns === 2 ? 1 : 2)],
      ["Expired row: " + onOff(draft.showExpired), () => void (draft.showExpired = !draft.showExpired)],
      ["Reset to defaults", () => void Object.assign(draft, { ...DEFAULTS, hiddenProviders: [] })],
    ];
    const choice = await ui.select("Quota settings (" + configPath() + ")", [...entries.map(([label]) => label), SAVE]);
    if (choice === undefined) return undefined;
    if (choice === SAVE) return draft;
    await entries.find(([label]) => label === choice)?.[1]();
  }
}

/** Toggles providers one at a time until Done (or Esc). */
async function pickProviders(ui: MenuUI, draft: Config): Promise<void> {
  for (;;) {
    const rows = PROVIDER_IDS.map((id) => (draft.hiddenProviders.includes(id) ? "[ ] " : "[x] ") + (NAMES[id] ?? id));
    const choice = await ui.select("Providers to collect and show", [...rows, DONE]);
    const id = PROVIDER_IDS[rows.indexOf(choice ?? "")];
    if (!id) return;
    draft.hiddenProviders = draft.hiddenProviders.includes(id)
      ? draft.hiddenProviders.filter((x) => x !== id)
      : [...draft.hiddenProviders, id];
  }
}

/** Whole number within range; Esc or empty keeps the current value, anything else invalid warns. */
async function askInt(ui: MenuUI, title: string, [low, high]: readonly [number, number], current: number): Promise<number> {
  const raw = (await ui.input(title + " (" + low + "-" + high + ")", String(current)))?.trim();
  if (!raw) return current;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= low && value <= high) return value;
  ui.notify("Expected a whole number from " + low + " to " + high + ".", "error");
  return current;
}
