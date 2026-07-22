import { describe, expect, it } from "vitest";
import { hashJson, hashUtf8 } from "./index.js";

describe("content hashes", () => {
  it("uses canonical JSON rather than insertion order", () => {
    expect(hashJson({ z: 1, a: 2 })).toBe(hashJson({ a: 2, z: 1 }));
  });

  it("matches the known SHA-256 digest for an empty string", () => {
    expect(hashUtf8("")).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
});
