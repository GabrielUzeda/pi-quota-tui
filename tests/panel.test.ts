// The panel can never draw a line wider than the terminal (it breaks the pi layout).
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { QuotaPanel } from "../src/panel.ts";
import { Monitor } from "../src/service.ts";
import type { Snapshot } from "../src/models.ts";

// Minimal theme: only what the panel uses. Colors become nothing; width is what matters here.
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
const NOW = Date.now() / 1000;

test("panel: no line goes past the width, with and without providers", () => {
  const monitor = new Monitor();
  const set = (m: Monitor, snaps: Snapshot[]) => (m as unknown as { data: Map<string, Snapshot[]> }).data.set(snaps[0].id, snaps);
    const panel = new QuotaPanel(monitor, theme);
  try {
    for (const width of [46, 20]) {
      for (const line of panel.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
    }
    set(monitor, [{ id: "openai", name: "OpenAI Codex with a name far too long",
      windows: [{ label: "5 horas", used: 97, resetsAt: NOW + 600, duration: 18000 }, { label: "Semanal", used: 40 }],
      updatedAt: NOW, source: "x", note: "a long note that has to be cut to fit the panel" }]);
    for (const width of [46, 20]) {
      for (const line of panel.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
    }
  } finally {
    monitor.stop();
  }
});
