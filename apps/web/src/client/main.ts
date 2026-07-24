import "@kineweave/studio/renderer/styles.css";
import "./web-auth.css";
import { initializeWebAuthentication } from "./web-auth.js";
import { createWebStudioHost } from "./web-host.js";

const authenticationRequired = await initializeWebAuthentication();

Object.defineProperty(window, "kineweaveHost", {
  configurable: false,
  enumerable: false,
  writable: false,
  value: createWebStudioHost(authenticationRequired)
});

await import("@kineweave/studio/renderer");
