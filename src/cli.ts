#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { Command, CommanderError, Option } from "commander";
import { addAccount } from "./account-add.js";
import { ACCESS_LEVELS, isAccessLevel } from "./account-permissions.js";
import { CliError, EXIT } from "./errors.js";
import { runGws } from "./run.js";

interface PackageMetadata {
  description: string;
  version: string;
}

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageMetadata;

function accessLevel(value: string): string {
  if (!isAccessLevel(value)) {
    throw new CommanderError(
      EXIT.usage,
      "mgws.invalidAccess",
      `expected one of: ${ACCESS_LEVELS.join(", ")}`,
    );
  }
  return value;
}

const program = new Command()
  .name("mgws")
  .description(packageMetadata.description)
  .version(packageMetadata.version)
  .showHelpAfterError()
  .exitOverride();

program
  .command("run")
  .description("Run gws with an isolated account and safety policy")
  .argument("<account>", "account slug")
  .argument("<gws-arguments...>", "arguments forwarded to gws")
  .option("--confirm", "confirm an action that changes external state")
  .allowUnknownOption()
  .action(
    (
      account: string,
      gwsArguments: string[],
      options: { confirm?: boolean },
    ) => {
      process.exitCode = runGws({
        account,
        confirmed: options.confirm === true,
        gwsArguments,
      });
    },
  );

const account = program
  .command("account")
  .description("Manage isolated Google accounts");

account
  .command("add")
  .description("Connect a Google account")
  .argument("<email>", "Google account email address")
  .addOption(
    new Option("--gmail <level>", "Gmail permission level")
      .argParser(accessLevel)
      .makeOptionMandatory(),
  )
  .addOption(
    new Option("--drive <level>", "Drive permission level")
      .argParser(accessLevel)
      .makeOptionMandatory(),
  )
  .option("--no-login", "create account state without starting OAuth")
  .action(
    (
      email: string,
      options: { gmail: string; drive: string; login: boolean },
    ) => {
      if (!isAccessLevel(options.gmail) || !isAccessLevel(options.drive)) {
        throw new CliError(EXIT.usage, "invalid permission level");
      }
      process.exitCode = addAccount({
        email,
        gmail: options.gmail,
        drive: options.drive,
        login: options.login,
      });
    },
  );

try {
  const rawArguments = process.argv.slice(2);
  const accountSlug = rawArguments[1];

  if (
    rawArguments[0] === "run" &&
    accountSlug !== undefined &&
    accountSlug !== "--help" &&
    accountSlug !== "-h"
  ) {
    const gwsArguments = rawArguments.slice(2);
    const confirmed = gwsArguments[0] === "--confirm";
    if (confirmed) gwsArguments.shift();
    process.exitCode = runGws({
      account: accountSlug,
      confirmed,
      gwsArguments,
    });
  } else {
    program.parse();
  }
} catch (error) {
  if (error instanceof CliError) {
    console.error(`mgws: ${error.message}`);
    process.exitCode = error.status;
  } else if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
