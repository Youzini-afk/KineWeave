import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { assertProjectPath } from "@kineweave/project-format";

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export async function resolveSafeProjectPath(
  rootPath: string,
  projectPath: string
): Promise<string> {
  assertProjectPath(projectPath);
  const canonicalRoot = await realpath(rootPath);
  const target = path.resolve(canonicalRoot, ...projectPath.split("/"));
  const relative = path.relative(canonicalRoot, target);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new TypeError(`Project path escapes root: ${projectPath}`);
  }

  let cursor = canonicalRoot;
  for (const segment of relative.split(path.sep)) {
    if (segment.length === 0) continue;
    cursor = path.join(cursor, segment);
    try {
      const status = await lstat(cursor);
      if (status.isSymbolicLink()) {
        throw new TypeError(`Project path crosses a symbolic link: ${projectPath}`);
      }
    } catch (error) {
      if (isMissing(error)) break;
      throw error;
    }
  }

  return target;
}
