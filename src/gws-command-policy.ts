const GMAIL_CONFIRM_ALIASES = new Set([
  "+send",
  "+reply",
  "+reply-all",
  "+forward",
]);
const GMAIL_PROHIBITED_METHODS = new Set([
  "messages:delete",
  "messages:batchDelete",
  "threads:delete",
  "drafts:delete",
]);
const GMAIL_CONFIRM_METHODS = new Set(["drafts:send", "messages:send"]);
const DRIVE_PROHIBITED_METHODS = new Set([
  "files:delete",
  "files:emptyTrash",
  "revisions:delete",
]);
const DRIVE_CONFIRM_METHODS = new Set([
  "permissions:create",
  "permissions:update",
  "permissions:delete",
]);
const CALENDAR_PROHIBITED_METHODS = new Set([
  "calendars:clear",
  "calendars:delete",
]);
const CALENDAR_CONFIRM_METHODS = new Set([
  "acl:insert",
  "acl:update",
  "acl:patch",
  "acl:delete",
  "events:insert",
  "events:import",
  "events:quickAdd",
  "events:update",
  "events:patch",
  "events:move",
  "events:delete",
]);
const GWS_VALUE_FLAGS = new Set([
  "--api-version",
  "--format",
  "--json",
  "--output",
  "--page-delay",
  "--page-limit",
  "--params",
  "--upload",
  "--upload-content-type",
]);

export type CommandPolicy =
  | { action: "allow" }
  | { action: "confirm"; reason: string }
  | { action: "prohibit"; reason: string };

function positionalArguments(args: readonly string[]): string[] {
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }

    const flag = argument.split("=", 1)[0];
    if (
      flag !== undefined &&
      GWS_VALUE_FLAGS.has(flag) &&
      !argument.includes("=")
    ) {
      index += 1;
    }
  }

  return positional;
}

export function classifyGwsCommand(args: readonly string[]): CommandPolicy {
  const [serviceWithVersion, resource, collection, method] =
    positionalArguments(args);
  const service = serviceWithVersion?.split(":", 1)[0];

  if (service === "gmail") {
    if (resource !== undefined && GMAIL_CONFIRM_ALIASES.has(resource)) {
      return {
        action: "confirm",
        reason: "Sending email requires explicit confirmation",
      };
    }

    if (resource === "users") {
      const operation = `${collection ?? ""}:${method ?? ""}`;
      if (GMAIL_PROHIBITED_METHODS.has(operation)) {
        return {
          action: "prohibit",
          reason: "Permanent Gmail deletion is prohibited",
        };
      }
      if (GMAIL_CONFIRM_METHODS.has(operation)) {
        return {
          action: "confirm",
          reason: "Sending email requires explicit confirmation",
        };
      }
    }
  }

  if (service === "drive") {
    const operation = `${resource ?? ""}:${collection ?? ""}`;
    if (DRIVE_PROHIBITED_METHODS.has(operation)) {
      return {
        action: "prohibit",
        reason: "Permanent Drive deletion is prohibited",
      };
    }
    if (DRIVE_CONFIRM_METHODS.has(operation)) {
      return {
        action: "confirm",
        reason: "Drive permission changes require explicit confirmation",
      };
    }
  }

  if (service === "calendar") {
    if (resource === "+insert") {
      return {
        action: "confirm",
        reason: "Creating Calendar events requires explicit confirmation",
      };
    }

    const operation = `${resource ?? ""}:${collection ?? ""}`;
    if (CALENDAR_PROHIBITED_METHODS.has(operation)) {
      return {
        action: "prohibit",
        reason: "Permanently clearing or deleting calendars is prohibited",
      };
    }
    if (CALENDAR_CONFIRM_METHODS.has(operation)) {
      return {
        action: "confirm",
        reason:
          "Calendar event and sharing changes require explicit confirmation",
      };
    }
  }

  return { action: "allow" };
}
