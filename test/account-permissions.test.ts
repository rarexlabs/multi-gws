import { describe, expect, it } from "vitest";
import { resolveAccountScopes } from "../src/account-permissions.js";

describe("resolveAccountScopes", () => {
  it("includes Gmail filters and full Drive management", () => {
    expect(
      resolveAccountScopes({
        gmail: "manage",
        drive: "manage",
        calendar: "manage",
      }),
    ).toEqual([
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.labels",
      "https://www.googleapis.com/auth/gmail.settings.basic",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/calendar",
    ]);
  });

  it("uses read-only scopes for read access", () => {
    expect(
      resolveAccountScopes({
        gmail: "read",
        drive: "read",
        calendar: "read",
      }),
    ).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
  });

  it("allows either service to be disabled", () => {
    expect(
      resolveAccountScopes({
        gmail: "none",
        drive: "none",
        calendar: "manage",
      }),
    ).toEqual(["https://www.googleapis.com/auth/calendar"]);
  });

  it("rejects disabling both services", () => {
    expect(() =>
      resolveAccountScopes({
        gmail: "none",
        drive: "none",
        calendar: "none",
      }),
    ).toThrow("at least one of Gmail, Drive, or Calendar must be enabled");
  });
});
