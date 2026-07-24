import { type ChildProcess, spawn, spawnSync } from "node:child_process";
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

const DEFAULT_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const OAUTH_KILL_GRACE_MS = 1000;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM"] as const;
type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];

function oauthTimeoutMs(): number {
  const configured = process.env.MGWS_OAUTH_TIMEOUT_MS;
  if (configured === undefined) return DEFAULT_OAUTH_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/.test(configured)) {
    throw new CliError(
      EXIT.usage,
      "MGWS_OAUTH_TIMEOUT_MS must be a positive integer",
    );
  }
  const timeout = Number(configured);
  if (!Number.isSafeInteger(timeout)) {
    throw new CliError(
      EXIT.usage,
      "MGWS_OAUTH_TIMEOUT_MS must be a positive integer",
    );
  }
  return timeout;
}

function terminateProcessTree(
  child: ChildProcess,
  signal: ForwardedSignal | "SIGKILL",
): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", child.pid.toString(), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

function runOauthLogin(
  root: string,
  slug: string,
  scopes: readonly string[],
): Promise<number> {
  const timeoutMs = oauthTimeoutMs();
  console.log(
    `Waiting up to ${timeoutMs}ms for OAuth approval. Press Ctrl-C to cancel.`,
  );

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
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
      {
        cwd: root,
        detached: process.platform !== "win32",
        stdio: "inherit",
      },
    );
    let completed = false;
    let terminationError: CliError | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const timeoutTimer = setTimeout(() => {
      requestTermination(
        "SIGTERM",
        new CliError(
          EXIT.unavailable,
          `OAuth login timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    const signalHandlers = new Map<ForwardedSignal, () => void>();

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
    };

    const reject = (error: CliError): void => {
      if (completed) return;
      completed = true;
      cleanup();
      rejectPromise(error);
    };

    const requestTermination = (
      signal: ForwardedSignal,
      error: CliError,
    ): void => {
      if (completed || terminationError !== undefined) return;
      terminationError = error;
      try {
        terminateProcessTree(child, signal);
      } catch (terminationFailure) {
        reject(
          new CliError(
            EXIT.unavailable,
            `could not terminate OAuth login: ${
              terminationFailure instanceof Error
                ? terminationFailure.message
                : String(terminationFailure)
            }`,
          ),
        );
        return;
      }
      killTimer = setTimeout(() => {
        try {
          terminateProcessTree(child, "SIGKILL");
        } catch {
          // The close handler reports the original timeout or cancellation.
        }
      }, OAUTH_KILL_GRACE_MS);
      killTimer.unref();
    };

    for (const signal of FORWARDED_SIGNALS) {
      const handler = (): void => {
        requestTermination(
          signal,
          new CliError(
            signal === "SIGINT" ? 130 : 143,
            `OAuth login cancelled by ${signal}`,
          ),
        );
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }

    child.once("error", (error) => {
      reject(
        new CliError(
          EXIT.unavailable,
          `could not start OAuth login: ${error.message}`,
        ),
      );
    });
    child.once("close", (status, signal) => {
      if (completed) return;
      if (terminationError !== undefined) {
        reject(terminationError);
        return;
      }
      completed = true;
      cleanup();
      if (status !== null) {
        resolvePromise(status);
        return;
      }
      rejectPromise(
        new CliError(
          1,
          `OAuth login terminated by signal ${signal ?? "unknown"}`,
        ),
      );
    });
  });
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

function ensurePrivateDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }

  const directory = lstatSync(path);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new CliError(EXIT.noPermission, `unsafe account path: ${path}`);
  }
  chmodSync(path, 0o700);
}

function ensureSafeFileIfPresent(path: string): void {
  if (!pathExists(path)) return;

  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new CliError(EXIT.noPermission, `unsafe account path: ${path}`);
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

export async function addAccount({
  email,
  gmail,
  drive,
  calendar,
  login,
  workspaceRoot,
}: AddAccountOptions): Promise<number> {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new CliError(EXIT.usage, `invalid email address: ${email}`);
  }
  const scopes = resolveAccountScopes({ gmail, drive, calendar });
  const slug = accountSlug(email);
  const root = resolve(workspaceRoot ?? process.cwd());
  const credentialsDir = join(root, "credentials");
  const oauthClient = join(credentialsDir, "google-oauth-client.json");
  const accountsDir = join(root, "accounts");
  const accountDir = join(accountsDir, slug);
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

  ensurePrivateDirectory(accountsDir);
  ensurePrivateDirectory(accountDir);
  ensurePrivateDirectory(configDir);

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
  ensureSafeFileIfPresent(accessProfile);

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

  const status = await runOauthLogin(root, slug, scopes);
  if (status === 0) saveAccessProfile();
  return status;
}
