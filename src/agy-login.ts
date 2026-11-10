// Antigravity accounts in the TUI's own file: /quota-login imports what AGY already had and,
// when the refresh token is no longer valid, runs the Google login here (OAuth loopback + PKCE).
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import {
  AGY_CLIENT,
  agyAccountsPath,
  agyLegacyPath,
  agyLoginToken,
  agyToken,
  parseAgyAccounts,
  readPrivateJson,
} from "./providers.ts";
import type { Json } from "./providers.ts";

export type Notify = (message: string, level?: "info" | "warning" | "error") => void;

const SCOPE = "openid email profile https://www.googleapis.com/auth/cloud-platform";
const TIMEOUT_MS = 5 * 60_000;

/** Writes the account list with mode 600: they are refresh tokens. */
export async function saveAccounts(target: string, accounts: readonly Json[]): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, JSON.stringify(accounts, null, 2) + "\n", { mode: 0o600 });
  // writeFile does not tighten the mode of an existing file.
  await chmod(target, 0o600);
}

/** Only the accounts whose refresh token Google still renews. */
export async function validAccounts(
  accounts: readonly ({ refreshToken: string } & Json)[],
  refresh: (token: string) => Promise<unknown> = agyToken,
): Promise<Json[]> {
  const valid: Json[] = [];
  for (const account of accounts) {
    try {
      await refresh(account.refreshToken.trim());
      valid.push(account);
    } catch {
      // Revoked token or one issued to another client: left out.
    }
  }
  return valid;
}

const CONSENT_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

export function agyConsentUrl(redirect: string, challenge: string): string {
  const query = new URLSearchParams({
    client_id: AGY_CLIENT,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return `${CONSENT_ENDPOINT}?${query}`;
}

/** E-mail from the id_token. Google signs it, but here it is only a local label. */
export function emailFromIdToken(token: unknown): string | undefined {
  if (typeof token !== "string") return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof (payload as Json).email === "string" ? ((payload as Json).email as string) : undefined;
  } catch {
    return undefined;
  }
}

const b64url = (buffer: Buffer): string => buffer.toString("base64url");

async function consentLogin(notify: Notify): Promise<Json> {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  let grant: (code: string) => void = () => {};
  let refuse: (error: Error) => void = () => {};
  const code = new Promise<string>((resolve, reject) => {
    grant = resolve;
    refuse = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") return void response.writeHead(404).end();
    const error = url.searchParams.get("error");
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error ? "Login cancelled." : "Login done, you can close this tab.");
    if (error) refuse(new Error("Google login cancelled."));
    else grant(url.searchParams.get("code") ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const redirect = `http://127.0.0.1:${port}/callback`;
  const timer = setTimeout(() => refuse(new Error("Timed out waiting for the browser login.")), TIMEOUT_MS);
  notify(`Open in the browser to sign in to the Antigravity account: ${agyConsentUrl(redirect, challenge)}`, "info");
  try {
    const granted = await code;
    if (!granted) throw new Error("Google did not return the authorization code.");
    const root = await agyLoginToken(granted, redirect, verifier);
    const refresh = root.refresh_token;
    if (typeof refresh !== "string" || !refresh) throw new Error("Google did not return a refresh token; try the login again.");
    // projectId stays out: without it the collection uses the Cloud Code default project.
    return { refreshToken: refresh, email: emailFromIdToken(root.id_token) };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

/** Imports from AGY when possible, otherwise runs the login in the extension itself. */
export async function loginAgy(notify: Notify): Promise<void> {
  const target = agyAccountsPath();
  const own = parseAgyAccounts(await readPrivateJson(target));
  if (own.length && (await validAccounts(own)).length === own.length) {
    notify(`Antigravity: ${own.length} account(s) already validated in ${target}.`, "info");
    return;
  }
  const imported = await validAccounts(parseAgyAccounts(await readPrivateJson(agyLegacyPath())));
  if (imported.length) {
    await saveAccounts(target, imported);
    notify(`Antigravity: ${imported.length} account(s) imported from AGY into ${target}.`, "info");
    return;
  }
  notify("Antigravity: no AGY token was valid; opening the Google login.", "warning");
  const account = await consentLogin(notify);
  await saveAccounts(target, [account]);
  notify(`Antigravity: conta ${account.email ?? "new"} saved to ${target}.`, "info");
}
