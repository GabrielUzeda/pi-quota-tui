// Per-provider response errors: valid JSON but useless responses become ReadError, not a crash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agySnapshot, parseAgyAccounts, parseCommandcode, parseOpencode, ReadError } from "../src/providers.ts";

const NOW = 1_700_000_000;

test("Antigravity: accounts without a refreshToken are dropped and garbage does not break the list", () => {
  assert.equal(parseAgyAccounts([{}, { refreshToken: "" }, null, 3, "x"]).length, 0);
  assert.equal(parseAgyAccounts({ accounts: [{ refreshToken: "r" }] }).length, 0);
});

test("Antigravity: an account without recognized groups keeps its own error, no windows", () => {
  const s = agySnapshot({ refreshToken: "r", email: "a@x" }, 0, [], NOW);
  assert.equal(s.windows.length, 0);
  assert.equal(s.error, "Account has no recognized quota reading.");
});

test("OpenCode: a response without recognized windows is a ReadError", () => {
  assert.throws(() => parseOpencode({ usage: { rolling: { percent: "abc" } } }, NOW), ReadError);
});

test("CommandCode: no credits is a ReadError", () => {
  assert.throws(() => parseCommandcode({}, undefined, NOW), ReadError);
});

test("CommandCode: without a 5h/weekly window it warns in the note, does not fail", () => {
  const s = parseCommandcode({ credits: { monthlyCredits: 5 } }, undefined, NOW);
  assert.match(s.note ?? "", /no 5h\/weekly window/);
});
