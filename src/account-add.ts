import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { AccountAccess } from "./account-permissions.js";
import { resolveAccountScopes } from "./account-permissions.js";
import { CliError, EXIT, errorCode } from "./errors.js";

export interface AddAccountOptions extends AccountAccess {
  email: string;
  login: boolean;
  workspaceRoot?: string;
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export function accountSlug(email: string): string {
  const normalizedEmail = email.toLowerCase();
  const readableSlug = normalizedEmail
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (readableSlug.length === 0) {
    throw new CliError(
      EXIT.usage,
      `could not derive an account slug from: ${email}`,
    );
  }
  const fingerprint = createHash("sha256")
    .update(normalizedEmail)
    .digest("base64url")
    .slice(0, 16);
  return `${readableSlug}-${fingerprint}`;
}

export function addAccount({
  email,
  gmail,
  drive,
  calendar,
  login,
  workspaceRoot,
}: AddAccountOptions): number {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new CliError(EXIT.usage, `invalid email address: ${email}`);
  }
  const scopes = resolveAccountScopes({ gmail, drive, calendar });
  const slug = accountSlug(email);
  const root = resolve(workspaceRoot ?? process.cwd());
  const credentialsDir = join(root, "credentials");
  const oauthClient = join(credentialsDir, "google-oauth-client.json");
  const accountDir = join(root, "accounts", slug);
  const configDir = join(accountDir, "gws");
  const accountOauthClient = join(configDir, "client_secret.json");
  const accessProfile = join(configDir, "access.json");

  if (!isFile(oauthClient)) {
    throw new CliError(
      EXIT.noInput,
      `OAuth client must be a regular file, not a symlink: ${oauthClient}`,
    );
  }
  const credentialsDirectory = lstatSync(credentialsDir);
  if (
    !credentialsDirectory.isDirectory() ||
    credentialsDirectory.isSymbolicLink()
  ) {
    throw new CliError(
      EXIT.noInput,
      `credentials path must be a regular directory: ${credentialsDir}`,
    );
  }
  chmodSync(credentialsDir, 0o700);
  chmodSync(oauthClient, 0o600);

  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(accountDir, 0o700);
  chmodSync(configDir, 0o700);

  if (pathExists(accountOauthClient)) {
    const accountOauthClientFile = lstatSync(accountOauthClient);
    if (
      !accountOauthClientFile.isFile() ||
      accountOauthClientFile.isSymbolicLink()
    ) {
      throw new CliError(
        EXIT.noInput,
        `account OAuth client must be a regular file: ${accountOauthClient}`,
      );
    }
  }
  copyFileSync(oauthClient, accountOauthClient);
  chmodSync(accountOauthClient, 0o600);

  const saveAccessProfile = (): void => {
    writeFileSync(
      accessProfile,
      `${JSON.stringify({ email, gmail, drive, calendar }, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    chmodSync(accessProfile, 0o600);
  };

  console.log(`Account slug: ${slug}`);
  console.log(`Gmail access: ${gmail}`);
  console.log(`Drive access: ${drive}`);
  console.log(`Calendar access: ${calendar}`);
  if (!login) {
    saveAccessProfile();
    console.log("Skipped OAuth login (--no-login).");
    return 0;
  }

  const result = spawnSync(
    process.execPath,
    [
      process.argv[1] ?? "mgws",
      "run",
      slug,
      "auth",
      "login",
      "--scopes",
      scopes.join(","),
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) {
    throw new CliError(
      EXIT.unavailable,
      `could not start OAuth login: ${result.error.message}`,
    );
  }
  if (result.status !== null) {
    if (result.status === 0) saveAccessProfile();
    return result.status;
  }
  throw new CliError(
    1,
    `OAuth login terminated by signal ${result.signal ?? "unknown"}`,
  );
}
