interface AuthenticationStatus {
  readonly authenticated: boolean;
  readonly required: boolean;
}

let pendingLogin: Promise<AuthenticationStatus> | undefined;

function sessionStatus(): Promise<Response> {
  return fetch("./api/auth/session", {
    cache: "no-store",
    credentials: "same-origin"
  });
}

function responseError(response: Response): Promise<string> {
  return response
    .json()
    .then((value: unknown) => {
      if (value !== null && typeof value === "object" && "error" in value) {
        const error = (value as { readonly error?: unknown }).error;
        if (typeof error === "string") return error;
      }
      return `Request failed with HTTP ${response.status}`;
    })
    .catch(() => `Request failed with HTTP ${response.status}`);
}

function login(): Promise<AuthenticationStatus> {
  const gate = document.createElement("section");
  gate.id = "auth-gate";
  gate.className = "auth-gate";
  gate.setAttribute("role", "dialog");
  gate.setAttribute("aria-modal", "true");
  gate.setAttribute("aria-labelledby", "auth-title");
  gate.setAttribute("aria-describedby", "auth-description");
  gate.innerHTML = `
    <div class="auth-orbit auth-orbit-one" aria-hidden="true"></div>
    <div class="auth-orbit auth-orbit-two" aria-hidden="true"></div>
    <main class="auth-card">
      <div class="auth-brand" aria-label="KineWeave Studio">
        <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M4 5.5 14 2l10 3.5v17L14 26 4 22.5z"/><path d="m9 8 5 6 5-6M9 20l5-6 5 6"/></svg>
        <span>KineWeave</span><b>Studio</b>
      </div>
      <div class="auth-heading">
        <span class="auth-kicker">Private cloud workspace</span>
        <h1 id="auth-title">Welcome back</h1>
        <p id="auth-description">Enter the access token configured for this KineWeave deployment.</p>
      </div>
      <form id="auth-form">
        <label for="auth-token">Deployment access token</label>
        <div class="auth-token-field">
          <input id="auth-token" name="accessToken" type="password" autocomplete="current-password" required autofocus />
          <button id="auth-reveal" type="button" aria-label="Show access token">Show</button>
        </div>
        <button id="auth-submit" class="auth-submit" type="submit"><span>Enter Studio</span><span aria-hidden="true">→</span></button>
        <p id="auth-error" class="auth-error" role="alert" aria-live="polite"></p>
      </form>
      <footer><span aria-hidden="true">●</span> Your token is exchanged for a protected browser session.</footer>
    </main>
  `;
  const studio = document.querySelector<HTMLElement>("#app");
  studio?.setAttribute("inert", "");
  document.body.append(gate);

  const form = gate.querySelector<HTMLFormElement>("#auth-form")!;
  const input = gate.querySelector<HTMLInputElement>("#auth-token")!;
  const reveal = gate.querySelector<HTMLButtonElement>("#auth-reveal")!;
  const submit = gate.querySelector<HTMLButtonElement>("#auth-submit")!;
  const error = gate.querySelector<HTMLElement>("#auth-error")!;
  input.focus();

  reveal.addEventListener("click", () => {
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    reveal.textContent = showing ? "Show" : "Hide";
    reveal.setAttribute("aria-label", `${showing ? "Show" : "Hide"} access token`);
    input.focus();
  });

  return new Promise<AuthenticationStatus>((resolve) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      error.textContent = "";
      submit.disabled = true;
      submit.dataset.loading = "true";
      submit.querySelector("span")!.textContent = "Signing in…";

      void fetch("./api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessToken: input.value })
      })
        .then(async (response) => {
          if (!response.ok) {
            if (response.status === 401) {
              throw new Error("That access token wasn't accepted. Check it and try again.");
            }
            if (response.status === 429) {
              const seconds = response.headers.get("retry-after");
              throw new Error(
                `Too many attempts. Try again${seconds === null ? " shortly" : ` in ${seconds} seconds`}.`
              );
            }
            throw new Error(await responseError(response));
          }
          const session = await sessionStatus();
          if (session.status === 401) {
            throw new Error(
              "A protected browser session could not be established. Use HTTPS and allow cookies for this site."
            );
          }
          if (!session.ok) throw new Error(await responseError(session));
          const status = (await session.json()) as AuthenticationStatus;
          input.value = "";
          studio?.removeAttribute("inert");
          gate.classList.add("leaving");
          gate.addEventListener("transitionend", () => gate.remove(), { once: true });
          setTimeout(() => gate.remove(), 250);
          resolve(status);
        })
        .catch((caught: unknown) => {
          error.textContent = caught instanceof Error ? caught.message : String(caught);
          input.select();
        })
        .finally(() => {
          submit.disabled = false;
          delete submit.dataset.loading;
          submit.querySelector("span")!.textContent = "Enter Studio";
        });
    });
  });
}

function pendingAuthentication(): Promise<AuthenticationStatus> {
  pendingLogin ??= login().finally(() => {
    pendingLogin = undefined;
  });
  return pendingLogin;
}

export async function requireWebAuthentication(): Promise<void> {
  await pendingAuthentication();
}

export async function initializeWebAuthentication(): Promise<boolean> {
  let response: Response;
  try {
    response = await sessionStatus();
  } catch {
    return (await pendingAuthentication()).required;
  }
  if (response.status === 401) {
    return (await pendingAuthentication()).required;
  }
  if (!response.ok) throw new Error(await responseError(response));
  const status = (await response.json()) as AuthenticationStatus;
  return status.required;
}

export async function signOutWebAuthentication(): Promise<void> {
  const response = await fetch("./api/auth/session", {
    method: "DELETE",
    credentials: "same-origin"
  });
  if (!response.ok) throw new Error(await responseError(response));
  window.location.reload();
}
