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
  [["drive", "drives", "delete"], "prohibit"],
  [["drive:v3", "files", "delete"], "prohibit"],
  [["--api-version", "v3", "drive", "files", "delete"], "prohibit"],
  [["--api-version=v3", "drive", "files", "delete"], "prohibit"],
  [["drive", "--api-version", "v3", "files", "delete"], "prohibit"],
  [["drive", "files", "--api-version", "v3", "delete"], "prohibit"],
  [["drive", "files", "emptyTrash"], "prohibit"],
  [["calendar", "events", "list"], "allow"],
  [["calendar", "+agenda"], "allow"],
  [["calendar", "+insert"], "allow"],
  [["calendar", "events", "insert"], "allow"],
  [["calendar", "events", "import"], "allow"],
  [["calendar", "events", "quickAdd"], "allow"],
  [["calendar", "events", "update"], "confirm"],
  [["calendar", "events", "delete"], "confirm"],
  [["calendar", "acl", "insert"], "confirm"],
  [["calendar", "acl", "delete"], "confirm"],
  [["calendar", "calendars", "clear"], "prohibit"],
  [["calendar:v3", "calendars", "delete"], "prohibit"],
];

describe("classifyGwsCommand", () => {
  it.each(cases)("%s is %s", (args, expected) => {
    expect(classifyGwsCommand(args).action).toBe(expected);
  });

  it.each([
    ["helper flag", ["calendar", "+insert", "--attendees", "me@example.com"]],
    [
      "inline helper flag",
      ["calendar", "+insert", "--attendees=ME@example.com"],
    ],
    [
      "API body",
      [
        "calendar",
        "events",
        "insert",
        "--json",
        '{"attendees":[{"email":"me@example.com"}]}',
      ],
    ],
  ])("allows self-only attendees from a %s", (_label, args) => {
    expect(classifyGwsCommand(args, "me@example.com").action).toBe("allow");
  });

  it.each([
    [
      "helper flag",
      [
        "calendar",
        "+insert",
        "--attendees",
        "me@example.com,other@example.com",
      ],
    ],
    [
      "API body",
      [
        "calendar",
        "events",
        "insert",
        '--json={"attendees":[{"email":"other@example.com"}]}',
      ],
    ],
  ])("confirms external attendees from a %s", (_label, args) => {
    expect(classifyGwsCommand(args, "me@example.com").action).toBe("confirm");
  });
});
