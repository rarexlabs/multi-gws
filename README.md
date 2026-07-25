# multi-gws

`multi-gws` provides the `mgws` command, a multi-account safety wrapper for the [Google Workspace CLI](https://github.com/googleworkspace/cli). It selects repository-local account credentials, blocks permanent deletion, and requires confirmation for consequential operations while forwarding the rest of the `gws` command surface.

## Requirements

- Node.js 22.9 or newer
- npm 11

## Usage

Run a Google Workspace command with a connected account:

```bash
mgws run <account-slug> <gws arguments...>
```

Add or reconnect an account:

```bash
mgws account add <email-address> --gmail=<none|read|manage> --drive=<none|read|manage> --calendar=<none|read|manage>
```

Account authorization streams the Google OAuth URL to the terminal and waits up
to five minutes for the browser callback. `Ctrl-C` and termination signals are
forwarded to the complete authorization process tree. Set
`MGWS_OAUTH_TIMEOUT_MS` to a positive integer to override the timeout.

`mgws` treats the current working directory as the workspace. Shared OAuth configuration belongs at `credentials/google-oauth-client.json`; account state is stored under `accounts/<account-slug>/gws/`.
Account slugs use the normalized email when it is available, then add incrementing
suffixes such as `-1` and `-2` only when another email already occupies that
slug. Reconnecting the same email reuses its existing slug.

## Development

```bash
npm install
npm run check
```

The package uses TypeScript 7, Vitest, and Biome. Commander provides the CLI structure while `mgws run` preserves trailing `gws` arguments for forwarding.

## Releasing

Maintainers can run `npm run release` from a clean `main` branch. The command
publishes the current version when it is not on npm yet; subsequent runs bump
the patch version. Use `npm run release -- minor` or `npm run release -- major`
to select a larger version bump. The workflow verifies the package, creates and
pushes the Git tag, and publishes to npm using the current npm credentials.

When npm requires a one-time password, provide the current code for that release:

```bash
NPM_CONFIG_OTP=<code> npm run release
```

## License

MIT
