# mgws

`mgws` is a multi-account safety wrapper for the [Google Workspace CLI](https://github.com/googleworkspace/cli). It selects repository-local account credentials, blocks permanent deletion, and requires confirmation for consequential operations while forwarding the rest of the `gws` command surface.

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
mgws account add <email-address> --gmail=<none|read|manage> --drive=<none|read|manage>
```

`mgws` treats the current working directory as the workspace. Shared OAuth configuration belongs at `credentials/google-oauth-client.json`; account state is stored under `accounts/<account-slug>/gws/`.

## Development

```bash
npm install
npm run check
```

The package uses TypeScript 7, Vitest, and Biome. Commander provides the CLI structure while `mgws run` preserves trailing `gws` arguments for forwarding.

## License

MIT
