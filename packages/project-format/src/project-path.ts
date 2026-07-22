const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const PORTABILITY_FORBIDDEN = /[<>:"|?*\u0000-\u001f\u007f]/;

export function validateProjectPath(value: string): string | undefined {
  if (value.length === 0) return "Project path cannot be empty";
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return "Project path must be relative";
  }
  if (value.includes("\\")) {
    return "Project path must use forward slashes";
  }

  const segments = value.split("/");
  for (const segment of segments) {
    if (segment.length === 0) return "Project path cannot contain empty segments";
    if (segment === "." || segment === "..") {
      return "Project path cannot contain dot segments";
    }
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      return "Project path segments cannot end with a dot or space";
    }
    if (WINDOWS_RESERVED_NAME.test(segment)) {
      return `Project path uses a reserved filename: ${segment}`;
    }
    if (PORTABILITY_FORBIDDEN.test(segment)) {
      return `Project path contains a non-portable character: ${segment}`;
    }
  }

  return undefined;
}

export function assertProjectPath(value: string): void {
  const reason = validateProjectPath(value);
  if (reason !== undefined) throw new TypeError(`${reason}: ${value}`);
}
