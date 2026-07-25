import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type AccountAccess, isAccessLevel } from "./account-permissions.js";
import { CliError, EXIT, errorCode } from "./errors.js";

export interface AccountProfile extends AccountAccess {
  slug: string;
  email: string;
}

const ACCESS_PROFILE = "access.json";

export function accountSlug(email: string): string {
  const slug = email
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) {
    throw new CliError(
      EXIT.usage,
      `could not derive an account slug from: ${email}`,
    );
  }
  return slug;
}

function isAccountProfile(value: unknown): value is AccountProfile {
  return (
    typeof value === "object" &&
    value !== null &&
    "slug" in value &&
    typeof value.slug === "string" &&
    "email" in value &&
    typeof value.email === "string" &&
    "gmail" in value &&
    typeof value.gmail === "string" &&
    isAccessLevel(value.gmail) &&
    "drive" in value &&
    typeof value.drive === "string" &&
    isAccessLevel(value.drive) &&
    "calendar" in value &&
    typeof value.calendar === "string" &&
    isAccessLevel(value.calendar)
  );
}

export function readAccountProfile(
  configDir: string,
  expectedSlug: string,
): AccountProfile | undefined {
  const path = join(configDir, ACCESS_PROFILE);
  let file: ReturnType<typeof lstatSync>;
  try {
    file = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new CliError(EXIT.noPermission, `unsafe account path: ${path}`);
  }

  let profile: unknown;
  try {
    profile = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!isAccountProfile(profile) || profile.slug !== expectedSlug) {
    return undefined;
  }
  return profile;
}

export function writeAccountProfile(
  configDir: string,
  profile: AccountProfile,
): void {
  const path = join(configDir, ACCESS_PROFILE);
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new CliError(EXIT.noPermission, `unsafe account path: ${path}`);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function existingAccountEmail(
  accountDir: string,
  slug: string,
): string | undefined {
  const directory = lstatSync(accountDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new CliError(EXIT.noPermission, `unsafe account path: ${accountDir}`);
  }
  return readAccountProfile(join(accountDir, "gws"), slug)?.email;
}

export function allocateAccountSlug(
  accountsDir: string,
  email: string,
): string {
  const baseSlug = accountSlug(email);
  const normalizedEmail = email.toLowerCase();

  for (let suffix = 0; Number.isSafeInteger(suffix); suffix += 1) {
    const slug = suffix === 0 ? baseSlug : `${baseSlug}-${suffix}`;
    const accountDir = join(accountsDir, slug);

    try {
      mkdirSync(accountDir, { mode: 0o700 });
      return slug;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }

    if (
      existingAccountEmail(accountDir, slug)?.toLowerCase() === normalizedEmail
    ) {
      return slug;
    }
  }

  throw new CliError(
    EXIT.unavailable,
    `could not allocate an account slug for: ${email}`,
  );
}
