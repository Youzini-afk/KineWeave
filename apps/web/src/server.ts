import { randomUUID, timingSafeEqual } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createOfficialProjectTemplate } from "@kineweave/official-distribution";
import type { LoadedProjectBundle } from "@kineweave/project-format";
import { NodeProjectRepository, type ProjectSnapshot } from "@kineweave/project-repository-node";
import type { Diagnostic } from "@kineweave/protocol";
import type {
  OpenedStudioProject,
  SavedStudioProject,
  StudioHostResult
} from "@kineweave/studio/host-api";
import { CLOUD_PROJECT_LOCATOR } from "./shared.js";

// ponytail: whole-bundle JSON is capped at 32 MiB; stream documents/resources when real projects exceed it.
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const SESSION_PATH = /^\/api\/project\/sessions\/([A-Za-z0-9_-]+)$/;
const AUTH_COOKIE_NAME = "kineweave_session";
const LOGIN_FAILURE_LIMIT = 10;
const LOGIN_FAILURE_WINDOW_MS = 5 * 60 * 1_000;

interface HostedProject {
  snapshot: ProjectSnapshot;
  saveQueue: Promise<void>;
  lastAccess: number;
}

export interface KineWeaveWebServerOptions {
  readonly projectRoot?: string;
  readonly clientRoot?: string;
  readonly accessToken?: string;
  readonly displayLocation?: string;
  readonly repository?: NodeProjectRepository;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function diagnosticsFrom(caught: unknown): readonly Diagnostic[] {
  return caught !== null &&
    typeof caught === "object" &&
    "diagnostics" in caught &&
    Array.isArray(caught.diagnostics)
    ? (caught.diagnostics as Diagnostic[])
    : [];
}

function failure<T>(caught: unknown): StudioHostResult<T> {
  const message = caught instanceof Error ? caught.message : String(caught);
  const diagnostics = diagnosticsFrom(caught);
  return {
    ok: false,
    error: {
      message,
      diagnostics:
        diagnostics.length === 0
          ? [
              {
                severity: "error",
                code: "web.server.host-failed",
                message,
                source: "@kineweave/web"
              }
            ]
          : diagnostics
    }
  };
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function sendEmpty(response: ServerResponse, statusCode: number): void {
  response.writeHead(statusCode, { "cache-control": "no-store" });
  response.end();
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, `${label} must be a non-empty string`);
  }
  return value;
}

function requestField(value: unknown, field: string): unknown {
  if (value === null || typeof value !== "object" || !(field in value)) {
    throw new HttpError(400, `Request is missing ${field}`);
  }
  return (value as Record<string, unknown>)[field];
}

function tokenMatches(expected: string, presented: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const presentedBytes = Buffer.from(presented);
  return (
    expectedBytes.length === presentedBytes.length && timingSafeEqual(expectedBytes, presentedBytes)
  );
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const prefix = `${name}=`;
  return request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}

function firstHeaderValue(value: string | readonly string[] | undefined): string | undefined {
  return (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();
}

function clientAddress(request: IncomingMessage): string {
  return (
    firstHeaderValue(request.headers["x-real-ip"]) ??
    firstHeaderValue(request.headers["x-forwarded-for"]) ??
    request.socket.remoteAddress ??
    "unknown"
  );
}

function authenticationCookie(
  request: IncomingMessage,
  value: string,
  maxAgeSeconds: number
): string {
  const protocol = firstHeaderValue(request.headers["x-forwarded-proto"])?.toLowerCase();
  const localHost = /^(?:localhost\.?|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(
    request.headers.host ?? ""
  );
  return [
    `${AUTH_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
    ...(maxAgeSeconds === 0 ? ["Expires=Thu, 01 Jan 1970 00:00:00 GMT"] : []),
    ...(protocol === "https" || !localHost ? ["Secure"] : [])
  ].join("; ");
}

function mimeType(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  clientRoot: string
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new HttpError(405, "Method not allowed");
  }
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(pathname).replace(/^\/+/, "") || "index.html";
  } catch {
    throw new HttpError(400, "URL path is not valid UTF-8");
  }
  const filePath = path.resolve(clientRoot, relativePath);
  const rootPrefix = `${path.resolve(clientRoot)}${path.sep}`;
  if (!filePath.startsWith(rootPrefix)) throw new HttpError(404, "Not found");

  let body: Buffer;
  try {
    body = await readFile(filePath);
  } catch {
    throw new HttpError(404, "Not found");
  }
  const immutable = relativePath.startsWith("assets/");
  response.writeHead(200, {
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "content-length": body.length,
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "content-type": mimeType(filePath),
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

async function initializeProject(
  repository: NodeProjectRepository,
  projectRoot: string
): Promise<ProjectSnapshot> {
  const existing = await repository.read(projectRoot);
  if (existing.snapshot !== undefined) return existing.snapshot;

  try {
    const entries = await readdir(projectRoot);
    if (entries.length > 0) {
      const error = new Error(
        "Configured cloud project is not a valid KineWeave project"
      ) as Error & {
        diagnostics: readonly Diagnostic[];
      };
      error.diagnostics = existing.diagnostics;
      throw error;
    }
  } catch (caught) {
    if (
      caught !== null &&
      typeof caught === "object" &&
      "code" in caught &&
      (caught as { code?: string }).code === "ENOENT"
    ) {
      // The repository initializer creates the missing directory.
    } else {
      throw caught;
    }
  }

  return repository.initialize(
    projectRoot,
    createOfficialProjectTemplate({
      name: "KineWeave Cloud Project",
      projectId: "project_cloud_default"
    })
  );
}

export async function createKineWeaveWebServer(
  options: KineWeaveWebServerOptions = {}
): Promise<Server> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(
    options.projectRoot ??
      process.env.KINEWEAVE_PROJECT_DIR ??
      path.join(process.cwd(), "data", "project")
  );
  const clientRoot = path.resolve(
    options.clientRoot ?? path.join(moduleDirectory, "..", "dist-client")
  );
  const accessToken = options.accessToken ?? process.env.KINEWEAVE_ACCESS_TOKEN;
  const displayLocation =
    options.displayLocation ?? process.env.KINEWEAVE_PROJECT_LABEL ?? "Cloud workspace";
  const repository = options.repository ?? new NodeProjectRepository();
  const authenticationRequired = accessToken !== undefined && accessToken.length > 0;
  await initializeProject(repository, projectRoot);

  // ponytail: process-local sessions fit one container; use a shared session service before scaling horizontally.
  const sessions = new Map<string, HostedProject>();
  const authenticationSessions = new Map<string, number>();
  // ponytail: managed hosting must overwrite forwarded client headers; add explicit trusted proxies for self-hosted chains.
  const loginFailures = new Map<string, { attempts: number; resetAt: number }>();
  const pruneSessions = () => {
    const now = Date.now();
    const staleBefore = now - SESSION_TTL_MS;
    for (const [sessionId, hosted] of sessions) {
      if (hosted.lastAccess < staleBefore) sessions.delete(sessionId);
    }
    for (const [sessionId, expiresAt] of authenticationSessions) {
      if (expiresAt <= now) authenticationSessions.delete(sessionId);
    }
    for (const [address, failure] of loginFailures) {
      if (failure.resetAt <= now) loginFailures.delete(address);
    }
  };

  const authenticated = (request: IncomingMessage): boolean => {
    if (!authenticationRequired) return true;
    const sessionId = cookieValue(request, AUTH_COOKIE_NAME);
    if (sessionId === undefined) return false;
    const expiresAt = authenticationSessions.get(sessionId);
    if (expiresAt === undefined || expiresAt <= Date.now()) {
      authenticationSessions.delete(sessionId);
      return false;
    }
    return true;
  };

  const handleApi = async (
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string
  ): Promise<void> => {
    pruneSessions();

    if (pathname === "/api/auth/session" && request.method === "GET") {
      const isAuthenticated = authenticated(request);
      sendJson(response, isAuthenticated ? 200 : 401, {
        authenticated: isAuthenticated,
        required: authenticationRequired
      });
      return;
    }

    if (pathname === "/api/auth/login" && request.method === "POST") {
      if (!authenticationRequired) {
        sendEmpty(response, 204);
        return;
      }
      const address = clientAddress(request);
      const failure = loginFailures.get(address);
      if (failure !== undefined && failure.attempts >= LOGIN_FAILURE_LIMIT) {
        response.setHeader(
          "retry-after",
          String(Math.max(1, Math.ceil((failure.resetAt - Date.now()) / 1_000)))
        );
        sendJson(response, 429, { error: "Too many sign-in attempts" });
        return;
      }
      const body = await readJsonBody(request);
      const presented = requiredString(requestField(body, "accessToken"), "accessToken");
      if (!tokenMatches(accessToken!, presented)) {
        const now = Date.now();
        loginFailures.set(address, {
          attempts: (failure?.attempts ?? 0) + 1,
          resetAt: failure?.resetAt ?? now + LOGIN_FAILURE_WINDOW_MS
        });
        sendJson(response, 401, { error: "The access token is not valid" });
        return;
      }

      loginFailures.delete(address);
      const previousSessionId = cookieValue(request, AUTH_COOKIE_NAME);
      if (previousSessionId !== undefined) authenticationSessions.delete(previousSessionId);
      const sessionId = randomUUID().replaceAll("-", "");
      authenticationSessions.set(sessionId, Date.now() + SESSION_TTL_MS);
      response.setHeader(
        "set-cookie",
        authenticationCookie(request, sessionId, SESSION_TTL_MS / 1_000)
      );
      sendEmpty(response, 204);
      return;
    }

    if (pathname === "/api/auth/session" && request.method === "DELETE") {
      const sessionId = cookieValue(request, AUTH_COOKIE_NAME);
      if (sessionId !== undefined) authenticationSessions.delete(sessionId);
      response.setHeader("set-cookie", authenticationCookie(request, "", 0));
      sendEmpty(response, 204);
      return;
    }

    if (!authenticated(request)) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    if (pathname === "/api/project/open" && request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        const projectLocator = requiredString(
          requestField(body, "projectLocator"),
          "projectLocator"
        );
        if (projectLocator !== CLOUD_PROJECT_LOCATOR) {
          throw new HttpError(404, `Unknown cloud project ${projectLocator}`);
        }
        const read = await repository.read(projectRoot);
        if (read.snapshot === undefined) {
          const error = new Error("Cloud project could not be opened") as Error & {
            diagnostics: readonly Diagnostic[];
          };
          error.diagnostics = read.diagnostics;
          throw error;
        }
        const hostSessionId = `web_${randomUUID().replaceAll("-", "")}`;
        sessions.set(hostSessionId, {
          snapshot: read.snapshot,
          saveQueue: Promise.resolve(),
          lastAccess: Date.now()
        });
        const opened: OpenedStudioProject = {
          hostSessionId,
          projectLocator,
          displayLocation,
          bundle: read.snapshot.bundle,
          diagnostics: read.diagnostics
        };
        sendJson(response, 200, {
          ok: true,
          value: opened
        } satisfies StudioHostResult<OpenedStudioProject>);
      } catch (caught) {
        if (caught instanceof HttpError) throw caught;
        sendJson(response, 200, failure<OpenedStudioProject>(caught));
      }
      return;
    }

    const sessionMatch = SESSION_PATH.exec(pathname);
    if (sessionMatch !== null && request.method === "PUT") {
      try {
        const hostSessionId = sessionMatch[1]!;
        const hosted = sessions.get(hostSessionId);
        if (hosted === undefined) throw new HttpError(404, "Cloud project session has expired");
        hosted.lastAccess = Date.now();
        const body = await readJsonBody(request);
        const rawBundle = requestField(body, "bundle");
        if (rawBundle === null || typeof rawBundle !== "object") {
          throw new HttpError(400, "bundle must be an object");
        }
        let saved!: ProjectSnapshot;
        const save = hosted.saveQueue.then(async () => {
          saved = await repository.save(hosted.snapshot, rawBundle as LoadedProjectBundle);
          hosted.snapshot = saved;
        });
        hosted.saveQueue = save.catch(() => {});
        await save;
        const value: SavedStudioProject = { bundle: saved.bundle };
        sendJson(response, 200, { ok: true, value } satisfies StudioHostResult<SavedStudioProject>);
      } catch (caught) {
        if (caught instanceof HttpError) throw caught;
        sendJson(response, 200, failure<SavedStudioProject>(caught));
      }
      return;
    }

    if (sessionMatch !== null && request.method === "DELETE") {
      sessions.delete(sessionMatch[1]!);
      sendEmpty(response, 204);
      return;
    }

    throw new HttpError(404, "API endpoint not found");
  };

  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/healthz") {
        sendJson(response, 200, { status: "ok" });
      } else if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url.pathname);
      } else {
        await serveStatic(request, response, url.pathname, clientRoot);
      }
    })().catch((caught: unknown) => {
      if (response.headersSent) {
        response.destroy(caught instanceof Error ? caught : new Error(String(caught)));
        return;
      }
      const statusCode = caught instanceof HttpError ? caught.statusCode : 500;
      const message = caught instanceof Error ? caught.message : String(caught);
      sendJson(response, statusCode, { error: message });
    });
  });
}

async function start(): Promise<void> {
  const rawPort = process.env.PORT ?? "8080";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer from 1 to 65535, received ${rawPort}`);
  }
  const server = await createKineWeaveWebServer();
  if (process.env.KINEWEAVE_ACCESS_TOKEN === undefined) {
    console.warn(
      "KINEWEAVE_ACCESS_TOKEN is not set; the project API is accessible to every network client"
    );
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  console.log(`KineWeave Web is listening on 0.0.0.0:${port}`);

  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
  void start().catch((caught: unknown) => {
    console.error(caught instanceof Error ? (caught.stack ?? caught.message) : String(caught));
    process.exitCode = 1;
  });
}
