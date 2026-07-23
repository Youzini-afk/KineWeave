import { describe, expect, it } from "vitest";
import { applyDocumentPatch, createDocumentPatch, diffJson } from "./patch.js";

describe("document patches", () => {
  it("round-trips changes including unknown extension data", () => {
    const before = {
      title: "Before",
      extension: { type: "org.example/fluid", data: { viscosity: 0.7 } }
    };
    const after = {
      title: "After",
      extension: {
        type: "org.example/fluid",
        data: { viscosity: 0.9, turbulence: true }
      }
    };
    const patch = createDocumentPatch("document_main", before, after);

    expect(applyDocumentPatch(before, patch)).toEqual(after);
    expect(applyDocumentPatch(after, patch, "inverse")).toEqual(before);
  });

  it("replaces arrays as an exact recovery unit", () => {
    expect(diffJson({ nodes: [1, 2] }, { nodes: [2, 1, 3] })).toEqual([
      { op: "replace", path: "/nodes", value: [2, 1, 3] }
    ]);
  });

  it("rejects applying a patch to an unexpected base", () => {
    const patch = createDocumentPatch("document_main", { value: 1 }, { value: 2 });
    expect(() => applyDocumentPatch({ value: 3 }, patch)).toThrow(/base mismatch/i);
  });

  it("supports document creation and deletion", () => {
    const creation = createDocumentPatch("document_new", null, { value: 1 });
    expect(applyDocumentPatch(null, creation)).toEqual({ value: 1 });
    expect(applyDocumentPatch({ value: 1 }, creation, "inverse")).toBeNull();
  });
});
