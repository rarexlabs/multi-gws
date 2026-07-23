export const ACCESS_LEVELS = ["none", "read", "manage"] as const;

export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export interface AccountAccess {
  gmail: AccessLevel;
  drive: AccessLevel;
  calendar: AccessLevel;
}

const GMAIL_SCOPES: Record<AccessLevel, readonly string[]> = {
  none: [],
  read: ["https://www.googleapis.com/auth/gmail.readonly"],
  manage: [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.labels",
    "https://www.googleapis.com/auth/gmail.settings.basic",
  ],
};

const DRIVE_SCOPES: Record<AccessLevel, readonly string[]> = {
  none: [],
  read: ["https://www.googleapis.com/auth/drive.readonly"],
  manage: ["https://www.googleapis.com/auth/drive"],
};

const CALENDAR_SCOPES: Record<AccessLevel, readonly string[]> = {
  none: [],
  read: ["https://www.googleapis.com/auth/calendar.readonly"],
  manage: ["https://www.googleapis.com/auth/calendar"],
};

export function isAccessLevel(value: string): value is AccessLevel {
  return ACCESS_LEVELS.includes(value as AccessLevel);
}

export function resolveAccountScopes({
  gmail,
  drive,
  calendar,
}: AccountAccess): string[] {
  if (gmail === "none" && drive === "none" && calendar === "none") {
    throw new RangeError(
      "at least one of Gmail, Drive, or Calendar must be enabled",
    );
  }

  return [
    ...GMAIL_SCOPES[gmail],
    ...DRIVE_SCOPES[drive],
    ...CALENDAR_SCOPES[calendar],
  ];
}
