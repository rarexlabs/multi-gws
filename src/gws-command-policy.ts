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
  "drives:delete",
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
  "events:update",
  "events:patch",
  "events:move",
  "events:delete",
]);
const CALENDAR_CREATE_METHODS = new Set([
  "events:insert",
  "events:import",
  "events:quickAdd",
]);
const GWS_VALUE_FLAGS = new Set([
  "--api-version",
  "--attendees",
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

function flagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === flag) {
      const value = args[index + 1];
      if (value !== undefined) {
        values.push(value);
        index += 1;
      }
    } else if (argument?.startsWith(`${flag}=`)) {
      values.push(argument.slice(flag.length + 1));
    }
  }

  return values;
}

function hasExternalAttendees(
  args: readonly string[],
  selfEmail: string | undefined,
): boolean {
  const normalizedSelf = selfEmail?.trim().toLowerCase();
  const isExternal = (email: string): boolean =>
    email.trim().toLowerCase() !== normalizedSelf;

  for (const value of flagValues(args, "--attendees")) {
    for (const email of value.split(",").filter((entry) => entry.length > 0)) {
      if (isExternal(email)) return true;
    }
  }

  for (const value of flagValues(args, "--json")) {
    let body: unknown;
    try {
      body = JSON.parse(value);
    } catch {
      return true;
    }
    if (typeof body !== "object" || body === null || !("attendees" in body)) {
      continue;
    }

    const attendees = body.attendees;
    if (!Array.isArray(attendees)) return true;
    for (const attendee of attendees) {
      if (
        typeof attendee !== "object" ||
        attendee === null ||
        !("email" in attendee) ||
        typeof attendee.email !== "string" ||
        isExternal(attendee.email)
      ) {
        return true;
      }
    }
  }

  return false;
}

export function classifyGwsCommand(
  args: readonly string[],
  selfEmail?: string,
): CommandPolicy {
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
      return hasExternalAttendees(args, selfEmail)
        ? {
            action: "confirm",
            reason:
              "Inviting other people to Calendar events requires explicit confirmation",
          }
        : { action: "allow" };
    }

    const operation = `${resource ?? ""}:${collection ?? ""}`;
    if (CALENDAR_PROHIBITED_METHODS.has(operation)) {
      return {
        action: "prohibit",
        reason: "Permanently clearing or deleting calendars is prohibited",
      };
    }
    if (CALENDAR_CREATE_METHODS.has(operation)) {
      return hasExternalAttendees(args, selfEmail)
        ? {
            action: "confirm",
            reason:
              "Inviting other people to Calendar events requires explicit confirmation",
          }
        : { action: "allow" };
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
