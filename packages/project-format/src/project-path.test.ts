import { describe, expect, it } from "vitest";
import { validateProjectPath } from "./project-path.js";

describe("portable project paths", () => {
  it("accepts portable relative paths", () => {
    expect(validateProjectPath("documents/场景-01.json")).toBeUndefined();
  });

  it.each([
    "../outside.json",
    "C:/absolute.json",
    "/absolute.json",
    "documents\\main.json",
    "documents/CON.json",
    "documents/trailing."
  ])("rejects %s", (value) => {
    expect(validateProjectPath(value)).toBeTypeOf("string");
  });
});
