import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import { access, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createOfficialDistributionProfile,
  createOfficialProjectTemplate,
  KINEWEAVE_VERSION
} from "@kineweave/official-distribution";
import type { LoadedProjectBundle } from "@kineweave/project-format";
import { NodeProjectRepository, type ProjectSnapshot } from "@kineweave/project-repository-node";
import {
  ProjectOutputJobManager,
  type ProjectOutputJobSnapshot
} from "@kineweave/project-session-node";
import type { Diagnostic } from "@kineweave/protocol";
import {
  type OpenedStudioProject,
  parseStudioOutputRequest,
  type SavedStudioProject,
  type StudioHostResult,
  type StudioOutputJob,
  type StudioOutputRequest
} from "@kineweave/studio/host-api";
import { CLOUD_PROJECT_LOCATOR } from "./shared.js";

// ponytail: whole-bundle JSON is capped at 32 MiB; stream documents/resources when real projects exceed it.
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_CONTROL_REQUEST_BYTES = 64 * 1024;
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const SESSION_PATH = /^\/api\/project\/sessions\/([A-Za-z0-9_-]+)$/;
const OUTPUT_PATH =
  /^\/api\/project\/sessions\/([A-Za-z0-9_-]+)\/outputs(?:\/([A-Za-z0-9_-]+)(?:\/(download))?)?$/;
const AUTH_COOKIE_NAME = "kineweave_session";
const LOGIN_FAILURE_LIMIT = 10;
const LOGIN_FAILURE_WINDOW_MS = 5 * 60 * 1_000;
const OUTPUT_ROOT_MARKER = ".kineweave-output-root";
const OUTPUT_ROOT_MARKER_CONTENT = "KineWeave transient output root v1\n";

interface HostedProject {
  snapshot: ProjectSnapshot;
  saveQueue: Promise<void>;
  lastAccess: number;
  readonly ownerId: string;
  outputJobId?: string;
}

export interface KineWeaveWebServerOptions {
  readonly projectRoot?: string;
  readonly clientRoot?: string;
  readonly accessToken?: string;
  readonly displayLocation?: string;
  readonly outputRoot?: string;
  readonly publicOrigin?: string;
  readonly trustProxy?: boolean;
  readonly repository?: NodeProjectRepository;
}

export interface KineWeaveWebServer extends Server {
  shutdown(deadlineMs?: number): Promise<void>;
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

function publicOutputJob(job: ProjectOutputJobSnapshot): StudioOutputJob {
  const result = job.result;
  const resultPath =
    result === undefined
      ? undefined
      : "outputDirectory" in result
        ? result.outputDirectory
        : result.outputPath;
  return {
    jobId: job.jobId,
    status: job.status,
    format: job.format,
    completedFrames: job.completedFrames,
    totalFrames: job.totalFrames,
    ...(result === undefined || resultPath === undefined
      ? {}
      : { result: { fileName: path.basename(resultPath), mediaType: result.mediaType } }),
    ...(job.error === undefined ? {} : { error: job.error })
  };
}

function outputRequest(value: unknown): StudioOutputRequest {
  try {
    const request = parseStudioOutputRequest(value);
    if (request.format !== "mp4" && request.format !== "webm") {
      throw new TypeError("Cloud output currently supports mp4 and webm");
    }
    return request;
  } catch (caught) {
    throw new HttpError(400, caught instanceof Error ? caught.message : String(caught));
  }
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

async function readJsonBody(
  request: IncomingMessage,
  maxBytes = MAX_REQUEST_BYTES
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "Request body is too large");
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

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
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

function booleanEnvironment(value: string | undefined, label: string): boolean {
  if (value === undefined || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new TypeError(`${label} must be true, false, 1 or 0`);
}

function normalizedPublicOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError("KINEWEAVE_PUBLIC_ORIGIN must be an HTTP(S) origin without a path");
  }
  return url.origin;
}

function requestOrigin(request: IncomingMessage, trustProxy: boolean): string {
  const protocol = trustProxy
    ? (firstHeaderValue(request.headers["x-forwarded-proto"])?.toLowerCase() ?? "http")
    : "encrypted" in request.socket && request.socket.encrypted === true
      ? "https"
      : "http";
  const host =
    (trustProxy ? firstHeaderValue(request.headers["x-forwarded-host"]) : undefined) ??
    request.headers.host;
  if ((protocol !== "http" && protocol !== "https") || host === undefined) {
    throw new HttpError(400, "Request origin could not be determined");
  }
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    throw new HttpError(400, "Request origin could not be determined");
  }
}

function requireSameOrigin(
  request: IncomingMessage,
  publicOrigin: string | undefined,
  trustProxy: boolean
): void {
  if (
    request.method !== "POST" &&
    request.method !== "PUT" &&
    request.method !== "PATCH" &&
    request.method !== "DELETE"
  ) {
    return;
  }
  const presented = firstHeaderValue(request.headers.origin);
  let normalized: string | undefined;
  try {
    normalized = presented === undefined ? undefined : new URL(presented).origin;
  } catch {
    // Rejected below with the same response as every other cross-origin request.
  }
  if (
    normalized === undefined ||
    normalized !== (publicOrigin ?? requestOrigin(request, trustProxy))
  ) {
    throw new HttpError(403, "Cross-origin state change rejected");
  }
}

function clientAddress(request: IncomingMessage, trustProxy: boolean): string {
  return (
    (trustProxy ? firstHeaderValue(request.headers["x-real-ip"]) : undefined) ??
    (trustProxy ? firstHeaderValue(request.headers["x-forwarded-for"]) : undefined) ??
    request.socket.remoteAddress ??
    "unknown"
  );
}

function authenticationCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${AUTH_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
    ...(maxAgeSeconds === 0 ? ["Expires=Thu, 01 Jan 1970 00:00:00 GMT"] : []),
    ...(secure ? ["Secure"] : [])
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
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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

function assertSeparateOutputRoot(projectRoot: string, outputRoot: string): void {
  if (
    outputRoot === path.parse(outputRoot).root ||
    pathContains(projectRoot, outputRoot) ||
    pathContains(outputRoot, projectRoot)
  ) {
    throw new Error("Cloud output directory must not overlap the project or filesystem root");
  }
}

async function prepareOutputRoot(projectRoot: string, outputRoot: string): Promise<void> {
  assertSeparateOutputRoot(projectRoot, outputRoot);
  await mkdir(outputRoot, { recursive: true });
  const [realProjectRoot, realOutputRoot] = await Promise.all([
    realpath(projectRoot),
    realpath(outputRoot)
  ]);
  assertSeparateOutputRoot(realProjectRoot, realOutputRoot);
  const entries = await readdir(outputRoot);
  const markerPath = path.join(outputRoot, OUTPUT_ROOT_MARKER);
  if (entries.length === 0) {
    await writeFile(markerPath, OUTPUT_ROOT_MARKER_CONTENT, { encoding: "utf8", flag: "wx" });
    return;
  }
  if (!entries.includes(OUTPUT_ROOT_MARKER)) {
    throw new Error("Cloud output directory is not empty or owned by KineWeave");
  }
  if ((await readFile(markerPath, "utf8")) !== OUTPUT_ROOT_MARKER_CONTENT) {
    throw new Error("Cloud output directory has an invalid KineWeave ownership marker");
  }
  // Output jobs are process-local and cannot resume, so only marked contents are safe to clear.
  await Promise.all(
    entries
      .filter((entry) => entry !== OUTPUT_ROOT_MARKER)
      .map((entry) => rm(path.join(outputRoot, entry), { recursive: true, force: true }))
  );
}

export async function createKineWeaveWebServer(
  options: KineWeaveWebServerOptions = {}
): Promise<KineWeaveWebServer> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(
    options.projectRoot ??
      process.env.KINEWEAVE_PROJECT_DIR ??
      path.join(process.cwd(), "data", "project")
  );
  const clientRoot = path.resolve(
    options.clientRoot ?? path.join(moduleDirectory, "..", "dist-client")
  );
  const outputRoot = path.resolve(
    options.outputRoot ??
      process.env.KINEWEAVE_OUTPUT_DIR ??
      path.join(path.dirname(projectRoot), "outputs")
  );
  const accessToken = options.accessToken ?? process.env.KINEWEAVE_ACCESS_TOKEN;
  const publicOrigin = normalizedPublicOrigin(
    options.publicOrigin ?? process.env.KINEWEAVE_PUBLIC_ORIGIN
  );
  const trustProxy =
    options.trustProxy ??
    booleanEnvironment(process.env.KINEWEAVE_TRUST_PROXY, "KINEWEAVE_TRUST_PROXY");
  const displayLocation =
    options.displayLocation ?? process.env.KINEWEAVE_PROJECT_LABEL ?? "Cloud workspace";
  const repository = options.repository ?? new NodeProjectRepository();
  const authenticationRequired = accessToken !== undefined && accessToken.length > 0;
  await initializeProject(repository, projectRoot);
  await prepareOutputRoot(projectRoot, outputRoot);

  // ponytail: process-local sessions fit one container; use a shared session service before scaling horizontally.
  const sessions = new Map<string, HostedProject>();
  const outputJobs = new ProjectOutputJobManager();
  const authenticationSessions = new Map<string, number>();
  // ponytail: one explicit proxy trust switch fits a single managed edge; add CIDR hops for proxy chains.
  const loginFailures = new Map<string, { attempts: number; resetAt: number }>();
  let draining = false;
  const removeOutputOwner = async (hostSessionId: string): Promise<void> => {
    const jobs = await outputJobs.removeOwner(hostSessionId);
    await Promise.all(
      jobs.map(async (job) => {
        const jobDirectory = path.dirname(job.outputPath);
        if (jobDirectory === outputRoot || !pathContains(outputRoot, jobDirectory)) {
          throw new Error(`Refusing to remove unsafe output directory ${jobDirectory}`);
        }
        await rm(jobDirectory, { recursive: true, force: true });
      })
    );
  };
  const closeHostedSession = async (hostSessionId: string): Promise<boolean> => {
    const hosted = sessions.get(hostSessionId);
    if (hosted === undefined) return false;
    sessions.delete(hostSessionId);
    await hosted.saveQueue;
    await removeOutputOwner(hostSessionId);
    return true;
  };
  const closeOwnerSessions = async (ownerId: string): Promise<void> => {
    const sessionIds = [...sessions]
      .filter(([, hosted]) => hosted.ownerId === ownerId)
      .map(([hostSessionId]) => hostSessionId);
    await Promise.all(sessionIds.map(closeHostedSession));
  };
  const pruneSessions = () => {
    const now = Date.now();
    const staleBefore = now - SESSION_TTL_MS;
    for (const [sessionId, hosted] of sessions) {
      if (hosted.lastAccess < staleBefore) {
        void closeHostedSession(sessionId).catch((caught) => console.error(caught));
      }
    }
    for (const [sessionId, expiresAt] of authenticationSessions) {
      if (expiresAt <= now) {
        authenticationSessions.delete(sessionId);
        void closeOwnerSessions(sessionId).catch((caught) => console.error(caught));
      }
    }
    for (const [address, failure] of loginFailures) {
      if (failure.resetAt <= now) loginFailures.delete(address);
    }
  };

  const authenticatedOwner = (request: IncomingMessage): string | undefined => {
    if (!authenticationRequired) return "public";
    const sessionId = cookieValue(request, AUTH_COOKIE_NAME);
    if (sessionId === undefined) return undefined;
    const expiresAt = authenticationSessions.get(sessionId);
    if (expiresAt === undefined || expiresAt <= Date.now()) {
      authenticationSessions.delete(sessionId);
      void closeOwnerSessions(sessionId).catch((caught) => console.error(caught));
      return undefined;
    }
    return sessionId;
  };
  const ownedHostedProject = (hostSessionId: string, ownerId: string): HostedProject => {
    const hosted = sessions.get(hostSessionId);
    if (hosted === undefined || hosted.ownerId !== ownerId) {
      throw new HttpError(404, "Cloud project session has expired");
    }
    return hosted;
  };
  const requireAcceptingWrites = (): void => {
    if (draining) throw new HttpError(503, "Server is shutting down");
  };

  const handleApi = async (
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string
  ): Promise<void> => {
    pruneSessions();
    requireSameOrigin(request, publicOrigin, trustProxy);

    if (pathname === "/api/auth/session" && request.method === "GET") {
      const isAuthenticated = authenticatedOwner(request) !== undefined;
      sendJson(response, isAuthenticated ? 200 : 401, {
        authenticated: isAuthenticated,
        required: authenticationRequired
      });
      return;
    }

    if (pathname === "/api/auth/login" && request.method === "POST") {
      if (!authenticationRequired) {
        requireAcceptingWrites();
        sendEmpty(response, 204);
        return;
      }
      const address = clientAddress(request, trustProxy);
      const failure = loginFailures.get(address);
      if (failure !== undefined && failure.attempts >= LOGIN_FAILURE_LIMIT) {
        response.setHeader(
          "retry-after",
          String(Math.max(1, Math.ceil((failure.resetAt - Date.now()) / 1_000)))
        );
        sendJson(response, 429, { error: "Too many sign-in attempts" });
        return;
      }
      const body = await readJsonBody(request, MAX_CONTROL_REQUEST_BYTES);
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
      if (previousSessionId !== undefined) {
        authenticationSessions.delete(previousSessionId);
        await closeOwnerSessions(previousSessionId);
      }
      requireAcceptingWrites();
      const sessionId = randomUUID().replaceAll("-", "");
      authenticationSessions.set(sessionId, Date.now() + SESSION_TTL_MS);
      response.setHeader(
        "set-cookie",
        authenticationCookie(
          sessionId,
          SESSION_TTL_MS / 1_000,
          (publicOrigin ?? requestOrigin(request, trustProxy)).startsWith("https://")
        )
      );
      sendEmpty(response, 204);
      return;
    }

    if (pathname === "/api/auth/session" && request.method === "DELETE") {
      const sessionId = cookieValue(request, AUTH_COOKIE_NAME);
      if (sessionId !== undefined) {
        authenticationSessions.delete(sessionId);
        await closeOwnerSessions(sessionId);
      }
      response.setHeader(
        "set-cookie",
        authenticationCookie(
          "",
          0,
          (publicOrigin ?? requestOrigin(request, trustProxy)).startsWith("https://")
        )
      );
      sendEmpty(response, 204);
      return;
    }

    const ownerId = authenticatedOwner(request);
    if (ownerId === undefined) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    if (pathname === "/api/project/open" && request.method === "POST") {
      try {
        const body = await readJsonBody(request, MAX_CONTROL_REQUEST_BYTES);
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
        requireAcceptingWrites();
        const hostSessionId = `web_${randomUUID().replaceAll("-", "")}`;
        sessions.set(hostSessionId, {
          snapshot: read.snapshot,
          saveQueue: Promise.resolve(),
          lastAccess: Date.now(),
          ownerId
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

    const outputMatch = OUTPUT_PATH.exec(pathname);
    if (outputMatch !== null) {
      const hostSessionId = outputMatch[1]!;
      const hosted = ownedHostedProject(hostSessionId, ownerId);
      hosted.lastAccess = Date.now();
      const jobId = outputMatch[2];
      const action = outputMatch[3];

      if (jobId === undefined && request.method === "POST") {
        try {
          const body = await readJsonBody(request, MAX_CONTROL_REQUEST_BYTES);
          const output = outputRequest(requestField(body, "request"));
          await hosted.saveQueue;
          if (sessions.get(hostSessionId) !== hosted) {
            throw new HttpError(404, "Cloud project session has expired");
          }
          requireAcceptingWrites();
          if (hosted.outputJobId !== undefined) {
            const previous = outputJobs.snapshot(hostSessionId, hosted.outputJobId);
            if (previous.status !== "running" && previous.status !== "cancelling") {
              await removeOutputOwner(hostSessionId);
              delete hosted.outputJobId;
              if (sessions.get(hostSessionId) !== hosted) {
                throw new HttpError(404, "Cloud project session has expired");
              }
              requireAcceptingWrites();
            }
          }
          const nextJobId = `output_${randomUUID().replaceAll("-", "")}`;
          const outputPath = path.join(outputRoot, nextJobId, `KineWeave-output.${output.format}`);
          const job = outputJobs.start({
            jobId: nextJobId,
            ownerId: hostSessionId,
            outputPath,
            bundle: hosted.snapshot.bundle,
            kineweaveVersion: KINEWEAVE_VERSION,
            distribution: createOfficialDistributionProfile(),
            ...output
          });
          hosted.outputJobId = nextJobId;
          sendJson(response, 202, {
            ok: true,
            value: publicOutputJob(job)
          } satisfies StudioHostResult<StudioOutputJob>);
        } catch (caught) {
          if (caught instanceof HttpError) throw caught;
          sendJson(response, 200, failure<StudioOutputJob>(caught));
        }
        return;
      }

      if (jobId !== undefined && action === undefined && request.method === "GET") {
        try {
          const job = outputJobs.snapshot(hostSessionId, jobId);
          sendJson(response, 200, {
            ok: true,
            value: publicOutputJob(job)
          } satisfies StudioHostResult<StudioOutputJob>);
        } catch (caught) {
          sendJson(response, 200, failure<StudioOutputJob>(caught));
        }
        return;
      }

      if (jobId !== undefined && action === undefined && request.method === "DELETE") {
        try {
          const job = await outputJobs.cancel(hostSessionId, jobId);
          sendJson(response, 200, {
            ok: true,
            value: publicOutputJob(job)
          } satisfies StudioHostResult<StudioOutputJob>);
        } catch (caught) {
          sendJson(response, 200, failure<StudioOutputJob>(caught));
        }
        return;
      }

      if (
        jobId !== undefined &&
        action === "download" &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        let job: ProjectOutputJobSnapshot;
        try {
          job = outputJobs.snapshot(hostSessionId, jobId);
        } catch {
          throw new HttpError(404, "Output job was not found");
        }
        if (job.status !== "succeeded" || job.result === undefined) {
          throw new HttpError(409, "Output is not ready to download");
        }
        if ("outputDirectory" in job.result) {
          throw new HttpError(409, "Cloud sequence archives are not available");
        }
        const outputPath = path.resolve(job.result.outputPath);
        if (!pathContains(outputRoot, outputPath)) {
          throw new Error("Output job resolved outside the configured output directory");
        }
        const file = await stat(outputPath);
        if (!file.isFile()) throw new HttpError(404, "Output file is missing");
        const fileName = path.basename(outputPath).replaceAll('"', "_");
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="${fileName}"`,
          "content-length": file.size,
          "content-type": job.result.mediaType,
          "x-content-type-options": "nosniff"
        });
        if (request.method === "HEAD") {
          response.end();
        } else {
          const stream = createReadStream(outputPath);
          stream.once("error", (caught) => response.destroy(caught));
          stream.pipe(response);
        }
        return;
      }
    }

    const sessionMatch = SESSION_PATH.exec(pathname);
    if (sessionMatch !== null && request.method === "PUT") {
      try {
        const hostSessionId = sessionMatch[1]!;
        const hosted = ownedHostedProject(hostSessionId, ownerId);
        hosted.lastAccess = Date.now();
        const body = await readJsonBody(request);
        const rawBundle = requestField(body, "bundle");
        if (rawBundle === null || typeof rawBundle !== "object") {
          throw new HttpError(400, "bundle must be an object");
        }
        if (sessions.get(hostSessionId) !== hosted) {
          throw new HttpError(404, "Cloud project session has expired");
        }
        requireAcceptingWrites();
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
      const hostSessionId = sessionMatch[1]!;
      ownedHostedProject(hostSessionId, ownerId);
      await closeHostedSession(hostSessionId);
      sendEmpty(response, 204);
      return;
    }

    throw new HttpError(404, "API endpoint not found");
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/healthz" && request.method === "GET") {
        sendJson(response, 200, { status: "ok" });
      } else if (url.pathname === "/readyz" && request.method === "GET") {
        if (draining) {
          sendJson(response, 503, { status: "draining" });
        } else {
          try {
            await Promise.all([
              access(projectRoot, fsConstants.R_OK | fsConstants.W_OK),
              access(outputRoot, fsConstants.R_OK | fsConstants.W_OK)
            ]);
            sendJson(response, 200, { status: "ready" });
          } catch {
            sendJson(response, 503, { status: "unavailable" });
          }
        }
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
  const webServer = server as KineWeaveWebServer;
  let shutdownPromise: Promise<void> | undefined;
  webServer.shutdown = (deadlineMs = 10_000): Promise<void> => {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
      return Promise.reject(new TypeError("Shutdown deadline must be a positive integer"));
    }
    if (shutdownPromise !== undefined) return shutdownPromise;
    draining = true;
    const closed = new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => (error === undefined ? resolve() : reject(error)));
      server.closeIdleConnections();
    });
    const cleanup = Promise.all([...sessions.keys()].map(closeHostedSession)).then(() => {
      authenticationSessions.clear();
      loginFailures.clear();
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        server.closeAllConnections();
        reject(new Error(`Web shutdown exceeded ${deadlineMs}ms`));
      }, deadlineMs);
      deadline.unref();
    });
    shutdownPromise = Promise.race([
      Promise.all([closed, cleanup]).then(() => {}),
      timedOut
    ]).finally(() => {
      if (deadline !== undefined) clearTimeout(deadline);
    });
    return shutdownPromise;
  };
  return webServer;
}

async function start(): Promise<void> {
  const rawPort = process.env.PORT ?? "8080";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer from 1 to 65535, received ${rawPort}`);
  }
  const server = await createKineWeaveWebServer();
  if (!process.env.KINEWEAVE_ACCESS_TOKEN) {
    console.warn(
      "KINEWEAVE_ACCESS_TOKEN is not set; the project API is accessible to every network client"
    );
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  console.log(`KineWeave Web is listening on 0.0.0.0:${port}`);

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void server.shutdown().then(
      () => process.exit(0),
      (caught: unknown) => {
        console.error(caught instanceof Error ? (caught.stack ?? caught.message) : String(caught));
        process.exit(1);
      }
    );
  };
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
