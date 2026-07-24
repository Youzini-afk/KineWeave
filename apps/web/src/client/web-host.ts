import type {
  OpenedStudioProject,
  SavedStudioProject,
  StudioHostApi,
  StudioHostResult
} from "@kineweave/studio/host-api";
import { CLOUD_PROJECT_LOCATOR } from "../shared.js";

const ACCESS_TOKEN_KEY = "kineweave.web.access-token";

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
  const send = (token: string | null) => {
    const headers = new Headers(init.headers);
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    return fetch(path, { ...init, headers });
  };

  let token = sessionStorage.getItem(ACCESS_TOKEN_KEY);
  let response = await send(token);
  if (response.status !== 401) return response;

  token = window.prompt("Enter the KineWeave deployment access token:");
  if (token === null || token.length === 0) {
    throw new Error("Access to this KineWeave deployment requires a token");
  }
  sessionStorage.setItem(ACCESS_TOKEN_KEY, token);
  response = await send(token);
  if (response.status === 401) sessionStorage.removeItem(ACCESS_TOKEN_KEY);
  return response;
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

export function createWebStudioHost(): StudioHostApi {
  return {
    hostKind: "web",
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
