import { describe, expect, it } from "vitest";
import {
  createProjectResourceUri,
  createResourceUri,
  parseResourceUri
} from "./resource-uri.js";

describe("resource URI", () => {
  it("round-trips canonical project resources", () => {
    const uri = createProjectResourceUri("document", "document_main", [
      "node",
      "node_headline"
    ]);
    expect(uri).toBe(
      "kw://project/document/document_main/node/node_headline"
    );
    expect(parseResourceUri(uri)).toEqual({
      authority: "project",
      segments: ["document", "document_main", "node", "node_headline"],
      canonical: uri
    });
  });

  it("encodes spaces but rejects traversal segments", () => {
    expect(createResourceUri("extension", ["org.example.tool", "hello world"]))
      .toBe("kw://extension/org.example.tool/hello%20world");
    expect(() => createResourceUri("project", ["document", ".."]))
      .toThrow(/segment/i);
  });
});
