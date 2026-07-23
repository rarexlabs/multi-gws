export const EXIT = {
  usage: 64,
  noInput: 66,
  unavailable: 69,
  noPermission: 77,
} as const;

export class CliError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
