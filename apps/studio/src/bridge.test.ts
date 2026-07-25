import { describe, expect, it } from "vitest";
import { parseStudioOutputRequest, parseStudioRationalText } from "./bridge.js";

describe("Studio output request parsing", () => {
  it("keeps decimal and fractional authoring values exact", () => {
    expect(parseStudioRationalText("29.97", "Frame rate")).toEqual({
      numerator: "2997",
      denominator: "100"
    });
    expect(parseStudioRationalText(" 30000/1001 ", "Frame rate")).toEqual({
      numerator: "30000",
      denominator: "1001"
    });
    expect(() => parseStudioRationalText("1e3", "Frame rate")).toThrow(
      "Frame rate must be a decimal or fraction"
    );
  });

  it("validates the complete host trust-boundary request", () => {
    const request = parseStudioOutputRequest({
      documentId: "document_main",
      format: "mp4",
      quality: "balanced",
      startTime: { numerator: "0", denominator: "1" },
      endTimeExclusive: { numerator: "1", denominator: "1" },
      framesPerSecond: { numerator: "30000", denominator: "1001" },
      viewport: {
        width: 1920,
        height: 1080,
        pixelRatio: { numerator: "1", denominator: "1" }
      }
    });
    expect(request.framesPerSecond).toEqual({ numerator: "30000", denominator: "1001" });
    expect(() =>
      parseStudioOutputRequest({ ...request, format: "png-sequence", quality: "high" })
    ).toThrow("Output quality only applies to video");
    expect(() =>
      parseStudioOutputRequest({ ...request, viewport: { ...request.viewport, width: 0 } })
    ).toThrow("Output width must be a positive safe integer");
  });
});
