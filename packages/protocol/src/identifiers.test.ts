import { describe, expect, it } from "vitest";
import { isNamespacedId, isStableId } from "./identifiers.js";

describe("identifiers", () => {
  it("accepts capability and node type identifiers", () => {
    expect(isNamespacedId("kineweave.renderer.2d")).toBe(true);
    expect(
      isNamespacedId("org.kineweave.standard-motion/set-node-property")
    ).toBe(true);
  });

  it("rejects unqualified or whitespace-delimited identifiers", () => {
    expect(isNamespacedId("Renderer 2D")).toBe(false);
    expect(isNamespacedId("/text")).toBe(false);
  });

  it("keeps stable object identifiers separate from type identifiers", () => {
    expect(isStableId("node_headline")).toBe(true);
    expect(isStableId("node/headline")).toBe(false);
  });
});
