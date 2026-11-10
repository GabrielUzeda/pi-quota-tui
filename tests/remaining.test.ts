// Remaining balance: the window bar fills with the balance, never with usage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { QuotaPanel } from "../src/panel.ts";
import { Monitor } from "../src/service.ts";
import { parseCodex } from "../src/providers.ts";

test("OpenAI: the panel shows the remaining balance in the hourly and weekly windows", async () => {
  const now = Date.now() / 1000;
  const snapshot = parseCodex({ rateLimits: {
    primary: { usedPercent: 8, windowDurationMins: 300, resetsAt: now + 3600 },
    secondary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: now + 3 * 86400 },
  } }, now);
  const monitor = new Monitor({ openai: async () => [snapshot] });
  await monitor.refresh();
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
  const panel = new QuotaPanel(monitor, theme);
  try {
    const text = panel.render(100).join("\n");
    // 92% and 83% balance: bar nearly full, without printing a percentage
    assert.match(text, /█{5,7}[│░]/);
    assert.doesNotMatch(text, /\d+%/);
    assert.deepEqual(snapshot.windows.map((w) => w.used), [8, 17]);
  } finally {
    monitor.stop();
  }
});
