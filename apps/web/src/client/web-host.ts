import type {
  OpenedStudioProject,
  SavedStudioProject,
  StudioHostApi,
  StudioHostResult,
  StudioOutputJob
} from "@kineweave/studio/host-api";
import { CLOUD_PROJECT_LOCATOR } from "../shared.js";
import { requireWebAuthentication, signOutWebAuthentication } from "./web-auth.js";

function failure<T>(caught: unknown): StudioHostResult<T> {
  const message = caught instanceof Error ? caught.message : String(caught);
  return {
    ok: false,
    error: {
      message,
      diagnostics: [
        {
          severity: "error",
          code: "web.host.request-failed",
          message,
          source: "@kineweave/web"
        }
      ]
    }
  };
}

function isHostResult<T>(value: unknown): value is StudioHostResult<T> {
  if (value === null || typeof value !== "object" || !("ok" in value)) return false;
  const result = value as {
    readonly ok?: unknown;
    readonly value?: unknown;
    readonly error?: unknown;
  };
  if (result.ok === true) return "value" in result;
  return result.ok === false && result.error !== null && typeof result.error === "object";
}

async function request(path: string, init: RequestInit): Promise<Response> {
  const send = () => fetch(path, { ...init, credentials: "same-origin" });
  const response = await send();
  if (response.status !== 401) return response;
  await requireWebAuthentication();
  return send();
}

async function requestResult<T>(path: string, init: RequestInit): Promise<StudioHostResult<T>> {
  try {
    const response = await request(path, init);
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail.length === 0 ? `Request failed with HTTP ${response.status}` : detail);
    }
    const value: unknown = await response.json();
    if (!isHostResult<T>(value)) throw new Error("Cloud host returned an invalid response");
    return value;
  } catch (caught) {
    return failure(caught);
  }
}

export function createWebStudioHost(authenticationRequired: boolean): StudioHostApi {
  return {
    hostKind: "web",
    outputFormats: ["mp4", "webm"],
    ...(authenticationRequired ? { signOut: signOutWebAuthentication } : {}),
    chooseProject: async () => CLOUD_PROJECT_LOCATOR,
    openProject: (projectLocator) =>
      requestResult<OpenedStudioProject>("./api/project/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectLocator })
      }),
    saveProject: (hostSessionId, bundle) =>
      requestResult<SavedStudioProject>(
        `./api/project/sessions/${encodeURIComponent(hostSessionId)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bundle })
        }
      ),
    async closeProject(hostSessionId) {
      const response = await request(
        `./api/project/sessions/${encodeURIComponent(hostSessionId)}`,
        { method: "DELETE" }
      );
      if (!response.ok && response.status !== 404) {
        throw new Error(`Cloud project session could not close (HTTP ${response.status})`);
      }
    },
    startOutput: (hostSessionId, outputRequest) =>
      requestResult<StudioOutputJob | undefined>(
        `./api/project/sessions/${encodeURIComponent(hostSessionId)}/outputs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ request: outputRequest })
        }
      ),
    getOutput: (hostSessionId, jobId) =>
      requestResult<StudioOutputJob>(
        `./api/project/sessions/${encodeURIComponent(hostSessionId)}/outputs/${encodeURIComponent(jobId)}`,
        { method: "GET" }
      ),
    cancelOutput: (hostSessionId, jobId) =>
      requestResult<StudioOutputJob>(
        `./api/project/sessions/${encodeURIComponent(hostSessionId)}/outputs/${encodeURIComponent(jobId)}`,
        { method: "DELETE" }
      ),
    async openOutput(hostSessionId, jobId) {
      try {
        const downloadPath = `./api/project/sessions/${encodeURIComponent(hostSessionId)}/outputs/${encodeURIComponent(jobId)}/download`;
        const link = document.createElement("a");
        link.href = downloadPath;
        link.download = "";
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
        return { ok: true, value: { opened: true } };
      } catch (caught) {
        return failure(caught);
      }
    },
    respondToClose: () => {},
    onInitialProject(listener) {
      let active = true;
      queueMicrotask(() => {
        if (active) listener(CLOUD_PROJECT_LOCATOR);
      });
      return () => {
        active = false;
      };
    },
    onCommand: () => () => {}
  };
}
