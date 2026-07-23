import { describe, expect, it } from "vitest";
import { classifyGwsCommand } from "../src/gws-command-policy.js";

const cases: Array<[string[], "allow" | "confirm" | "prohibit"]> = [
  [["gmail", "users", "messages", "list"], "allow"],
  [["gmail", "+send"], "confirm"],
  [["gmail", "users", "drafts", "send"], "confirm"],
  [["gmail", "users", "messages", "delete"], "prohibit"],
  [["gmail", "users", "drafts", "delete"], "prohibit"],
  [["drive", "files", "list"], "allow"],
  [["drive", "permissions", "create"], "confirm"],
  [["drive", "files", "delete"], "prohibit"],
  [["drive:v3", "files", "delete"], "prohibit"],
  [["--api-version", "v3", "drive", "files", "delete"], "prohibit"],
  [["--api-version=v3", "drive", "files", "delete"], "prohibit"],
  [["drive", "--api-version", "v3", "files", "delete"], "prohibit"],
  [["drive", "files", "--api-version", "v3", "delete"], "prohibit"],
  [["drive", "files", "emptyTrash"], "prohibit"],
];

describe("classifyGwsCommand", () => {
  it.each(cases)("%s is %s", (args, expected) => {
    expect(classifyGwsCommand(args).action).toBe(expected);
  });
});
