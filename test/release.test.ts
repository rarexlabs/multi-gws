import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];

async function executable(path: string, source: string): Promise<void> {
  await writeFile(path, `#!/usr/bin/env node\n${source}`);
  await chmod(path, 0o755);
}

afterEach(async () => {
  await Promise.all(
    fixtures.map((fixture) => rm(fixture, { recursive: true, force: true })),
  );
  fixtures.length = 0;
});

describe("release workflow", () => {
  it("tests once and does not push a tag when npm publish fails", async () => {
    if (process.platform === "win32") return;

    const root = await mkdtemp(join(tmpdir(), "multi-gws-release-"));
    fixtures.push(root);
    const scripts = join(root, "scripts");
    const bin = join(root, "bin");
    const log = join(root, "commands.jsonl");
    await mkdir(scripts);
    await mkdir(bin);
    await copyFile(
      resolve("scripts/release.mjs"),
      join(scripts, "release.mjs"),
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "multi-gws", version: "0.0.1" }),
    );

    const logger = `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.RELEASE_LOG, JSON.stringify({ command: process.argv[1].split("/").at(-1), args }) + "\\n");
`;
    await executable(
      join(bin, "git"),
      `${logger}
const invocation = args.join(" ");
if (invocation === "branch --show-current") console.log("main");
else if (invocation === "remote get-url origin") console.log("https://example.test/repo.git");
else if (invocation === "rev-parse HEAD") console.log("head");
else if (args[0] === "rev-list") process.exit(1);
`,
    );
    await executable(
      join(bin, "npm"),
      `${logger}
if (args[0] === "whoami") console.log("tester");
else if (args[0] === "view") {
  console.error("E404");
  process.exit(1);
} else if (args[0] === "publish") {
  console.error("EOTP");
  process.exit(1);
}
`,
    );

    const result = spawnSync(process.execPath, [join(scripts, "release.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        RELEASE_LOG: log,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/npm publish exited with 1/);

    const commands = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { command: string; args: string[] });
    const testRuns = commands.filter(
      ({ command, args }) =>
        command === "npm" &&
        (args[0] === "test" ||
          (args[0] === "run" && args[1] === "check") ||
          (args[0] === "pack" && !args.includes("--ignore-scripts"))),
    );
    expect(testRuns).toHaveLength(1);
    expect(commands).toContainEqual({
      command: "npm",
      args: ["pack", "--dry-run", "--ignore-scripts"],
    });
    expect(
      commands.some(
        ({ command, args }) => command === "git" && args[0] === "push",
      ),
    ).toBe(false);
  });
});
