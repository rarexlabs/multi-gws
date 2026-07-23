import { describe, expect, it } from "vitest";
import { resolveAccountScopes } from "../src/account-permissions.js";

describe("resolveAccountScopes", () => {
  it("includes Gmail filters and full Drive management", () => {
    expect(resolveAccountScopes({ gmail: "manage", drive: "manage" })).toEqual([
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.labels",
      "https://www.googleapis.com/auth/gmail.settings.basic",
      "https://www.googleapis.com/auth/drive",
    ]);
  });

  it("uses read-only scopes for read access", () => {
    expect(resolveAccountScopes({ gmail: "read", drive: "read" })).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ]);
  });

  it("allows either service to be disabled", () => {
    expect(resolveAccountScopes({ gmail: "none", drive: "manage" })).toEqual([
      "https://www.googleapis.com/auth/drive",
    ]);
  });

  it("rejects disabling both services", () => {
    expect(() =>
      resolveAccountScopes({ gmail: "none", drive: "none" }),
    ).toThrow("at least one of Gmail or Drive must be enabled");
  });
});
