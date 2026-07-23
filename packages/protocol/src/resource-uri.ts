export type ResourceAuthority = "project" | "extension";
export type ResourceUri = string;

export interface ParsedResourceUri {
  readonly authority: ResourceAuthority;
  readonly segments: readonly string[];
  readonly canonical: ResourceUri;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function assertSegment(segment: string): void {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    containsControlCharacter(segment)
  ) {
    throw new TypeError(`Invalid resource URI segment: ${segment}`);
  }
}

export function createResourceUri(
  authority: ResourceAuthority,
  segments: readonly string[]
): ResourceUri {
  if (segments.length === 0) {
    throw new TypeError("A resource URI requires at least one path segment");
  }

  for (const segment of segments) assertSegment(segment);
  return `kw://${authority}/${segments.map(encodeURIComponent).join("/")}`;
}

export function createProjectResourceUri(
  kind: "document" | "asset" | "component" | "reference",
  stableId: string,
  nestedSegments: readonly string[] = []
): ResourceUri {
  return createResourceUri("project", [kind, stableId, ...nestedSegments]);
}

export function createExtensionResourceUri(
  extensionId: string,
  nestedSegments: readonly string[]
): ResourceUri {
  return createResourceUri("extension", [extensionId, ...nestedSegments]);
}

export function parseResourceUri(value: string): ParsedResourceUri {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`Invalid resource URI: ${value}`);
  }

  if (parsed.protocol !== "kw:") {
    throw new TypeError(`Unsupported resource URI scheme: ${parsed.protocol}`);
  }

  if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    throw new TypeError("Resource URIs cannot contain credentials, ports, query or fragment");
  }

  if (parsed.hostname !== "project" && parsed.hostname !== "extension") {
    throw new TypeError(`Unsupported resource URI authority: ${parsed.hostname}`);
  }

  const rawSegments = parsed.pathname.split("/").slice(1);
  if (rawSegments.length === 0 || rawSegments.some((segment) => segment.length === 0)) {
    throw new TypeError("Resource URI path cannot contain empty segments");
  }

  const segments = rawSegments.map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new TypeError(`Invalid percent encoding in resource URI: ${value}`);
    }
    assertSegment(decoded);
    return decoded;
  });

  const authority = parsed.hostname as ResourceAuthority;
  return {
    authority,
    segments,
    canonical: createResourceUri(authority, segments)
  };
}

export function isResourceUri(value: string): boolean {
  try {
    parseResourceUri(value);
    return true;
  } catch {
    return false;
  }
}
