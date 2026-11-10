// A failing provider stays visible as NO SIGNAL, it does not vanish from the panel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { health } from "../src/rules.ts";
import { Monitor } from "../src/service.ts";

test("service: a failing provider stays visible as NO SIGNAL, it does not vanish", () => {
  const monitor = new Monitor();
  (monitor as unknown as { fail(provider: string, message: string): void }).fail("antigravity", "Start the AGY proxy");
  const [s] = monitor.snapshots("antigravity");
  assert.equal(s.disabled, false);
  assert.equal(s.name, "Antigravity");
  assert.equal(s.error, "Start the AGY proxy");
  assert.equal(health(s, Date.now() / 1000), "NO SIGNAL");
  monitor.stop();
});
