import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountSlug } from "../src/account-add.js";

const cli = resolve("dist/cli.js");
const workspaces: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "mgws-"));
  workspaces.push(workspace);
  await mkdir(join(workspace, "credentials"));
  await writeFile(
    join(workspace, "credentials/google-oauth-client.json"),
    "{}\n",
  );
  return workspace;
}

async function createFakeGws(root: string, body: string): Promise<string> {
  const executable = join(root, "fake-gws");
  await writeFile(executable, `#!/bin/sh\n${body}\n`);
  await chmod(executable, 0o755);
  return executable;
}

function run(workspace: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await lstat(path);
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`timed out waiting for file: ${path}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  const build = spawnSync(
    process.execPath,
    ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"],
    {
      cwd: resolve("."),
      encoding: "utf8",
    },
  );
  expect(build.status, build.stderr).toBe(0);
});

afterAll(async () => {
  await Promise.all(
    workspaces.map((workspace) =>
      rm(workspace, { recursive: true, force: true }),
    ),
  );
});

describe("mgws run", () => {
  it("selects an account and enforces command policy", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "accounts/test/gws"), { recursive: true });
    const fakeGws = await createFakeGws(
      workspace,
      "printf 'config=%s\\n' \"$GOOGLE_WORKSPACE_CLI_CONFIG_DIR\"\nprintf '%s\\n' \"$@\"",
    );
    const env = { GWS_EXECUTABLE: fakeGws };

    const prohibited = run(
      workspace,
      ["run", "test", "--confirm", "drive:v3", "files", "delete"],
      env,
    );
    expect(prohibited.status).toBe(77);
    expect(prohibited.stderr).toMatch(/Permanent Drive deletion is prohibited/);

    const unconfirmed = run(workspace, ["run", "test", "gmail", "+send"], env);
    expect(unconfirmed.status).toBe(77);
    expect(unconfirmed.stderr).toMatch(/explicit confirmation/);

    const confirmed = run(
      workspace,
      ["run", "test", "--confirm", "gmail", "+send"],
      env,
    );
    expect(confirmed.status, confirmed.stderr).toBe(0);
    const configDir = await realpath(join(workspace, "accounts/test/gws"));
    expect(confirmed.stdout).toBe(`config=${configDir}\ngmail\n+send\n`);

    const personalCalendarEvent = run(
      workspace,
      ["run", "test", "calendar", "events", "insert"],
      env,
    );
    expect(personalCalendarEvent.status, personalCalendarEvent.stderr).toBe(0);
    expect(personalCalendarEvent.stdout).toBe(
      `config=${configDir}\ncalendar\nevents\ninsert\n`,
    );

    const confirmedCalendar = run(
      workspace,
      ["run", "test", "--confirm", "calendar", "events", "insert"],
      env,
    );
    expect(confirmedCalendar.status, confirmedCalendar.stderr).toBe(0);
    expect(confirmedCalendar.stdout).toBe(
      `config=${configDir}\ncalendar\nevents\ninsert\n`,
    );

    const forwardedHelp = run(
      workspace,
      ["run", "test", "drive", "files", "list", "--help"],
      env,
    );
    expect(forwardedHelp.status, forwardedHelp.stderr).toBe(0);
    expect(forwardedHelp.stdout).toBe(
      `config=${configDir}\ndrive\nfiles\nlist\n--help\n`,
    );
  });

  it("isolates inherited credentials and resolves file arguments from the workspace", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "accounts/test/gws"), { recursive: true });
    const fakeGws = await createFakeGws(
      workspace,
      "printf 'cwd=%s\\n' \"$PWD\"\nprintf 'token=%s\\n' \"$GOOGLE_WORKSPACE_CLI_TOKEN\"\nprintf 'credentials_set=%s\\n' \"$" +
        '{GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE+x}"\nprintf \'adc=%s\\n\' "$GOOGLE_APPLICATION_CREDENTIALS"\nprintf \'%s\\n\' "$@"',
    );

    const result = run(
      workspace,
      [
        "run",
        "test",
        "drive",
        "files",
        "list",
        "--upload",
        "relative.txt",
        "--output=download.bin",
      ],
      {
        GWS_EXECUTABLE: fakeGws,
        GOOGLE_WORKSPACE_CLI_TOKEN: "wrong-token",
        GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: "/tmp/wrong-account.json",
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/wrong-adc.json",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const canonicalWorkspace = await realpath(workspace);
    const configDir = join(canonicalWorkspace, "accounts/test/gws");
    expect(result.stdout).toBe(
      [
        `cwd=${join(configDir, ".runtime")}`,
        "token=",
        "credentials_set=",
        `adc=${join(configDir, ".runtime", ".env", "no-adc")}`,
        "drive",
        "files",
        "list",
        "--upload",
        join(canonicalWorkspace, "relative.txt"),
        `--output=${join(canonicalWorkspace, "download.bin")}`,
        "",
      ].join("\n"),
    );
  });

  it("rejects a symlinked account config directory", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "accounts/source/gws"), { recursive: true });
    await mkdir(join(workspace, "accounts/alias"), { recursive: true });
    await symlink("../source/gws", join(workspace, "accounts/alias/gws"));
    const fakeGws = await createFakeGws(workspace, "exit 0");

    const result = run(workspace, ["run", "alias", "drive", "files", "list"], {
      GWS_EXECUTABLE: fakeGws,
    });

    expect(result.status).toBe(77);
    expect(result.stderr).toMatch(/unsafe account path/);
  });

  it("confirms calendar creation only for attendees other than the connected account", async () => {
    const workspace = await createWorkspace();
    const email = "person@example.com";
    const added = run(workspace, [
      "account",
      "add",
      email,
      "--gmail=none",
      "--drive=none",
      "--calendar=manage",
      "--no-login",
    ]);
    expect(added.status, added.stderr).toBe(0);
    const slug = accountSlug(email);
    const fakeGws = await createFakeGws(workspace, "exit 0");
    const env = { GWS_EXECUTABLE: fakeGws };

    const selfOnly = run(
      workspace,
      ["run", slug, "calendar", "+insert", "--attendees", "PERSON@example.com"],
      env,
    );
    expect(selfOnly.status, selfOnly.stderr).toBe(0);

    const external = run(
      workspace,
      ["run", slug, "calendar", "+insert", "--attendees", "other@example.com"],
      env,
    );
    expect(external.status).toBe(77);
    expect(external.stderr).toMatch(/explicit confirmation/);
  });
});

describe("mgws account add", () => {
  it("times out OAuth login and terminates its process group", async () => {
    const workspace = await createWorkspace();
    const childPidFile = join(workspace, "oauth-child.pid");
    const fakeGws = await createFakeGws(
      workspace,
      `echo $$ > '${childPidFile}'\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done`,
    );

    const result = spawnSync(
      process.execPath,
      [
        cli,
        "account",
        "add",
        "person@example.com",
        "--gmail=read",
        "--drive=none",
        "--calendar=none",
      ],
      {
        cwd: workspace,
        encoding: "utf8",
        env: {
          ...process.env,
          GWS_EXECUTABLE: fakeGws,
          MGWS_OAUTH_TIMEOUT_MS: "500",
        },
        timeout: 2_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(69);
    expect(result.stderr).toMatch(/OAuth login timed out after 500ms/);
    const childPid = Number.parseInt(await readFile(childPidFile, "utf8"), 10);
    expect(isProcessAlive(childPid)).toBe(false);
    await expect(
      lstat(
        join(
          workspace,
          "accounts",
          accountSlug("person@example.com"),
          "gws/access.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("forwards termination to an in-progress OAuth login", async () => {
    const workspace = await createWorkspace();
    const childPidFile = join(workspace, "oauth-child.pid");
    const fakeGws = await createFakeGws(
      workspace,
      `echo $$ > '${childPidFile}'\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done`,
    );
    const child = spawn(
      process.execPath,
      [
        cli,
        "account",
        "add",
        "person@example.com",
        "--gmail=read",
        "--drive=none",
        "--calendar=none",
      ],
      {
        cwd: workspace,
        stdio: "ignore",
        env: { ...process.env, GWS_EXECUTABLE: fakeGws },
      },
    );

    await waitForFile(childPidFile);
    const oauthPid = Number.parseInt(await readFile(childPidFile, "utf8"), 10);
    try {
      child.kill("SIGTERM");
      const exit = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolveExit) => {
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
      });
      expect(exit.signal).toBeNull();
      expect(exit.code).toBe(143);
      expect(isProcessAlive(oauthPid)).toBe(false);
    } finally {
      if (isProcessAlive(oauthPid)) process.kill(oauthPid, "SIGTERM");
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });

  it("creates private, collision-safe account state", async () => {
    const workspace = await createWorkspace();
    const add = (email: string) =>
      run(workspace, [
        "account",
        "add",
        email,
        "--gmail=read",
        "--drive=none",
        "--calendar=manage",
        "--no-login",
      ]);

    const plusAddress = add("a+b@example.com");
    const dashAddress = add("a-b@example.com");
    expect(plusAddress.status, plusAddress.stderr).toBe(0);
    expect(dashAddress.status, dashAddress.stderr).toBe(0);

    const plusSlug = plusAddress.stdout.match(/Account slug: (\S+)/)?.[1];
    const dashSlug = dashAddress.stdout.match(/Account slug: (\S+)/)?.[1];
    expect(plusSlug).toBeDefined();
    expect(dashSlug).toBeDefined();
    expect(plusSlug).not.toBe(dashSlug);

    const accountDir = join(workspace, "accounts", plusSlug as string);
    const configDir = join(accountDir, "gws");
    const accountOauthClient = join(configDir, "client_secret.json");
    const accessProfile = JSON.parse(
      await readFile(join(configDir, "access.json"), "utf8"),
    ) as unknown;
    expect((await lstat(join(workspace, "credentials"))).mode & 0o777).toBe(
      0o700,
    );
    expect(
      (await lstat(join(workspace, "credentials/google-oauth-client.json")))
        .mode & 0o777,
    ).toBe(0o600);
    expect((await lstat(accountDir)).mode & 0o777).toBe(0o700);
    expect((await lstat(configDir)).mode & 0o777).toBe(0o700);
    expect((await lstat(accountOauthClient)).isSymbolicLink()).toBe(false);
    expect((await lstat(accountOauthClient)).mode & 0o777).toBe(0o600);
    expect(accessProfile).toEqual({
      email: "a+b@example.com",
      gmail: "read",
      drive: "none",
      calendar: "manage",
    });
  });

  it("rejects a symbolic link as the shared OAuth client", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mgws-"));
    workspaces.push(workspace);
    const externalClient = join(workspace, "external-oauth-client.json");
    await mkdir(join(workspace, "credentials"));
    await writeFile(externalClient, "{}\n", { mode: 0o644 });
    await symlink(
      externalClient,
      join(workspace, "credentials/google-oauth-client.json"),
    );

    const result = run(workspace, [
      "account",
      "add",
      "person@example.com",
      "--gmail=read",
      "--drive=none",
      "--calendar=none",
      "--no-login",
    ]);

    expect(result.status).toBe(66);
    expect(result.stderr).toMatch(/must be a regular file, not a symlink/);
    expect((await lstat(externalClient)).mode & 0o777).toBe(0o644);
  });

  it("rejects a symlinked account directory", async () => {
    const workspace = await createWorkspace();
    const email = "person@example.com";
    const slug = accountSlug(email);
    const externalAccount = join(workspace, "external-account");
    await mkdir(join(workspace, "accounts"));
    await mkdir(externalAccount);
    await symlink(externalAccount, join(workspace, "accounts", slug));

    const result = run(workspace, [
      "account",
      "add",
      email,
      "--gmail=read",
      "--drive=none",
      "--calendar=none",
      "--no-login",
    ]);

    expect(result.status).toBe(77);
    expect(result.stderr).toMatch(/unsafe account path/);
    await expect(lstat(join(externalAccount, "gws"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a symlinked access profile without overwriting its target", async () => {
    const workspace = await createWorkspace();
    const email = "person@example.com";
    const slug = accountSlug(email);
    const configDir = join(workspace, "accounts", slug, "gws");
    const externalProfile = join(workspace, "external-access.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(externalProfile, "sentinel\n");
    await symlink(externalProfile, join(configDir, "access.json"));

    const result = run(workspace, [
      "account",
      "add",
      email,
      "--gmail=read",
      "--drive=none",
      "--calendar=none",
      "--no-login",
    ]);

    expect(result.status).toBe(77);
    expect(result.stderr).toMatch(/unsafe account path/);
    expect(await readFile(externalProfile, "utf8")).toBe("sentinel\n");
  });
});
