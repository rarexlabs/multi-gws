import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const allowedBumps = new Set(["patch", "minor", "major"]);
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: npm run release -- [patch|minor|major]

With no argument, publishes the current version if it is not on npm yet;
otherwise bumps and publishes a patch version.`);
  process.exit(0);
}

if (args.length > 1 || (args[0] && !allowedBumps.has(args[0]))) {
  fail("Expected at most one version bump: patch, minor, or major");
}

const requestedBump = args[0] ?? "patch";
const bumpWasExplicit = args.length === 1;

function fail(message) {
  console.error(`Release failed: ${message}`);
  process.exit(1);
}

function commandLabel(command, commandArgs) {
  return [command, ...commandArgs].join(" ");
}

function run(command, commandArgs) {
  console.log(`\n> ${commandLabel(command, commandArgs)}`);
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) {
    fail(`${commandLabel(command, commandArgs)} exited with ${result.status}`);
  }
}

function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    fail(`${commandLabel(command, commandArgs)} exited with ${result.status}`);
  }
  return result.stdout.trim();
}

function packageMetadata() {
  return JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
}

function assertCleanWorktree() {
  if (capture("git", ["status", "--porcelain"])) {
    fail(
      "the Git worktree is not clean; commit or stash changes before releasing",
    );
  }
}

function isPublished(name, version) {
  const spec = `${name}@${version}`;
  const result = spawnSync(npmCommand, ["view", spec, "version", "--json"], {
    encoding: "utf8",
  });

  if (result.status === 0) return true;
  if (`${result.stdout}\n${result.stderr}`.includes("E404")) return false;

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  fail(`could not determine whether ${spec} is already published`);
}

function ensureTag(tag) {
  const head = capture("git", ["rev-parse", "HEAD"]);
  const result = spawnSync("git", ["rev-list", "-n", "1", tag], {
    encoding: "utf8",
  });

  if (result.status !== 0 || !result.stdout.trim()) {
    run("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);
    return;
  }

  if (result.stdout.trim() !== head) {
    fail(`${tag} already exists on a different commit`);
  }
}

assertCleanWorktree();

const branch = capture("git", ["branch", "--show-current"]);
if (branch !== "main") {
  fail(`releases must run from main, not ${branch || "detached HEAD"}`);
}

capture("git", ["remote", "get-url", "origin"]);
run(npmCommand, ["whoami"]);
run(npmCommand, ["run", "check"]);
run(npmCommand, ["pack", "--dry-run", "--ignore-scripts"]);
assertCleanWorktree();

let { name, version } = packageMetadata();
const currentVersionIsPublished = isPublished(name, version);

if (currentVersionIsPublished || bumpWasExplicit) {
  run(npmCommand, ["version", requestedBump, "-m", "chore: release v%s"]);
  ({ name, version } = packageMetadata());
} else {
  console.log(
    `\n${name}@${version} is not published yet; releasing the current version.`,
  );
}

const tag = `v${version}`;
ensureTag(tag);
run(npmCommand, ["publish"]);
run("git", ["push", "origin", "main", "--follow-tags"]);

console.log(`\nReleased ${name}@${version} (${tag}).`);
