import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyConsentUrl, emailFromIdToken, saveAccounts, validAccounts } from "../src/agy-login.ts";

test("saveAccounts creates the directory and writes with mode 600", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "quota-login-")), "nested");
  const file = join(dir, "agy-accounts.json");
  await saveAccounts(file, [{ refreshToken: "r1", email: "a@b.c" }]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), [{ refreshToken: "r1", email: "a@b.c" }]);
});

test("saveAccounts tightens the mode of an existing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-login-"));
  const file = join(dir, "agy.json");
  await saveAccounts(file, [{ refreshToken: "r1" }]);
  const { chmod } = await import("node:fs/promises");
  await chmod(file, 0o644);
  await saveAccounts(file, [{ refreshToken: "r2" }]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("validAccounts drops the token Google does not renew", async () => {
  const accounts = [{ refreshToken: " good " }, { refreshToken: "dead" }];
  const seen: string[] = [];
  const valid = await validAccounts(accounts, async (token) => {
    seen.push(token);
    if (token === "dead") throw new Error("revoked");
    return "access";
  });
  assert.deepEqual(seen, ["good", "dead"]);
  assert.deepEqual(valid, [{ refreshToken: " good " }]);
});

test("agyConsentUrl carries the client, offline scope and PKCE", () => {
  const url = new URL(agyConsentUrl("http://127.0.0.1:1234/callback", "challenge"));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:1234/callback");
  assert.equal(url.searchParams.get("code_challenge"), "challenge");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.match(url.searchParams.get("scope") ?? "", /cloud-platform/);
  assert.ok((url.searchParams.get("client_id") ?? "").endsWith(".apps.googleusercontent.com"));
});

test("emailFromIdToken reads the e-mail and ignores garbage", () => {
  const payload = Buffer.from(JSON.stringify({ email: "account@example.com" })).toString("base64url");
  assert.equal(emailFromIdToken(`header.${payload}.signature`), "account@example.com");
  assert.equal(emailFromIdToken(undefined), undefined);
  assert.equal(emailFromIdToken("no.dots"), undefined);
  assert.equal(emailFromIdToken("a.not-json.c"), undefined);
});
