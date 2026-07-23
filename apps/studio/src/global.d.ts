import type { StudioHostApi } from "./bridge.js";

declare global {
  interface Window {
    readonly kineweaveHost: StudioHostApi;
  }
}
