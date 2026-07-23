import { spawnSync } from "node:child_process";
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

    const unconfirmedCalendar = run(
      workspace,
      ["run", "test", "calendar", "events", "insert"],
      env,
    );
    expect(unconfirmedCalendar.status).toBe(77);
    expect(unconfirmedCalendar.stderr).toMatch(/explicit confirmation/);

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
});

describe("mgws account add", () => {
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
});
