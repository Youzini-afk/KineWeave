import "@kineweave/studio/renderer/styles.css";
import { createWebStudioHost } from "./web-host.js";

Object.defineProperty(window, "kineweaveHost", {
  configurable: false,
  enumerable: false,
  writable: false,
  value: createWebStudioHost()
});

await import("@kineweave/studio/renderer");
