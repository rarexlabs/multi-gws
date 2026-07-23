import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { CliError, EXIT, errorCode } from "./errors.js";
import { classifyGwsCommand } from "./gws-command-policy.js";

const require = createRequire(import.meta.url);
const FILE_PATH_FLAGS = new Set(["--output", "--upload"]);

export interface RunOptions {
  account: string;
  confirmed: boolean;
  gwsArguments: string[];
  workspaceRoot?: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function ensureRuntimeDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const directory = lstatSync(path);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new CliError(EXIT.noPermission, `unsafe runtime directory: ${path}`);
  }
  chmodSync(path, 0o700);

  const dotenv = join(path, ".env");
  try {
    writeFileSync(dotenv, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }

  const dotenvFile = lstatSync(dotenv);
  if (
    !dotenvFile.isFile() ||
    dotenvFile.isSymbolicLink() ||
    dotenvFile.size !== 0
  ) {
    throw new CliError(
      EXIT.noPermission,
      `unsafe runtime environment file: ${dotenv}`,
    );
  }
  chmodSync(dotenv, 0o600);
}

export function resolveFileArguments(
  args: readonly string[],
  root: string,
): string[] {
  const resolvedArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (FILE_PATH_FLAGS.has(argument) && index + 1 < args.length) {
      const value = args[index + 1];
      if (value !== undefined) {
        resolvedArgs.push(
          argument,
          value === "-" || isAbsolute(value) ? value : resolve(root, value),
        );
        index += 1;
        continue;
      }
    }

    const inlineFlag = [...FILE_PATH_FLAGS].find((flag) =>
      argument.startsWith(`${flag}=`),
    );
    if (inlineFlag !== undefined) {
      const value = argument.slice(inlineFlag.length + 1);
      resolvedArgs.push(
        `${inlineFlag}=${value === "-" || isAbsolute(value) ? value : resolve(root, value)}`,
      );
      continue;
    }

    resolvedArgs.push(argument);
  }

  return resolvedArgs;
}

export function runGws({
  account,
  confirmed,
  gwsArguments,
  workspaceRoot,
}: RunOptions): number {
  if (
    !/^[A-Za-z0-9._-]+$/.test(account) ||
    account.startsWith(".") ||
    account.includes("..")
  ) {
    throw new CliError(EXIT.usage, `invalid account slug: ${account}`);
  }
  if (gwsArguments.length === 0) {
    throw new CliError(EXIT.usage, "missing gws arguments");
  }

  const root = resolve(workspaceRoot ?? process.cwd());
  const configDir = join(root, "accounts", account, "gws");
  const runtimeDir = join(configDir, ".runtime");
  const gwsOverride = process.env.GWS_EXECUTABLE;
  const gwsEntrypoint = require.resolve("@googleworkspace/cli/run.js");
  const gwsExecutable = gwsOverride ?? process.execPath;
  const gwsPrefixArgs = gwsOverride === undefined ? [gwsEntrypoint] : [];

  if (!isDirectory(configDir)) {
    throw new CliError(
      EXIT.noInput,
      `unknown account: ${account}\nask your agent to use $add-account to connect it`,
    );
  }
  if (
    gwsOverride !== undefined
      ? !isExecutable(gwsExecutable)
      : !isFile(gwsEntrypoint)
  ) {
    throw new CliError(
      EXIT.unavailable,
      "gws is not installed; run: npm install",
    );
  }

  const policy = classifyGwsCommand(gwsArguments);
  if (policy.action === "prohibit")
    throw new CliError(EXIT.noPermission, policy.reason);
  if (policy.action === "confirm" && !confirmed) {
    throw new CliError(
      EXIT.noPermission,
      `${policy.reason}\nafter confirmation, rerun with --confirm after the account slug`,
    );
  }

  ensureRuntimeDirectory(runtimeDir);
  const gwsEnv = { ...process.env };
  delete gwsEnv.GOOGLE_WORKSPACE_CLI_CLIENT_ID;
  delete gwsEnv.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET;
  delete gwsEnv.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;

  const result = spawnSync(
    gwsExecutable,
    [...gwsPrefixArgs, ...resolveFileArguments(gwsArguments, root)],
    {
      cwd: runtimeDir,
      env: {
        ...gwsEnv,
        GOOGLE_APPLICATION_CREDENTIALS: join(runtimeDir, ".env", "no-adc"),
        GOOGLE_WORKSPACE_CLI_CONFIG_DIR: configDir,
        GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "keyring",
        GOOGLE_WORKSPACE_CLI_TOKEN: "",
      },
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw new CliError(
      EXIT.unavailable,
      `could not run gws: ${result.error.message}`,
    );
  }
  if (result.status !== null) return result.status;
  throw new CliError(
    1,
    `gws terminated by signal ${result.signal ?? "unknown"}`,
  );
}
