import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANVAS2D_SURFACE_TYPE,
  type Canvas2DContextLike,
  type Canvas2DPathLike,
  type Canvas2DTextMetricsLike,
  canvas2dRendererProvider
} from "@kineweave/canvas2d-renderer";
import { validatePresentationGraph } from "@kineweave/evaluation-engine";
import type { ResolvedPresentationGraph } from "@kineweave/protocol";
import { SVG_OUTPUT_TARGET, svgRendererProvider } from "@kineweave/svg-renderer";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const goldenRoot = path.join(repositoryRoot, "examples", "golden");

interface TracePath extends Canvas2DPathLike {
  readonly data: string;
}

interface TraceCall {
  readonly operation: string;
  readonly arguments: readonly unknown[];
}

interface ContextState {
  readonly globalAlpha: number;
  readonly fillStyle: unknown;
  readonly strokeStyle: unknown;
  readonly lineWidth: number;
  readonly font: string;
  readonly textAlign: string;
  readonly textBaseline: string;
}

class TraceContext implements Canvas2DContextLike {
  globalAlpha = 1;
  fillStyle: unknown = "#000000";
  strokeStyle: unknown = "#000000";
  lineWidth = 1;
  font = "10px sans-serif";
  textAlign = "start";
  textBaseline = "alphabetic";
  readonly calls: TraceCall[] = [];
  readonly #states: ContextState[] = [];

  operations(): string[] {
    return this.calls.map((call) => call.operation);
  }

  #record(operation: string, ...args: readonly unknown[]): void {
    this.calls.push({ operation, arguments: args });
  }

  save(): void {
    this.#states.push({
      globalAlpha: this.globalAlpha,
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline
    });
    this.#record("save");
  }

  restore(): void {
    const state = this.#states.pop();
    if (state !== undefined) {
      this.globalAlpha = state.globalAlpha;
      this.fillStyle = state.fillStyle;
      this.strokeStyle = state.strokeStyle;
      this.lineWidth = state.lineWidth;
      this.font = state.font;
      this.textAlign = state.textAlign;
      this.textBaseline = state.textBaseline;
    }
    this.#record("restore");
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.#record("setTransform", a, b, c, d, e, f);
  }

  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.#record("transform", a, b, c, d, e, f);
  }

  clearRect(x: number, y: number, width: number, height: number): void {
    this.#record("clearRect", x, y, width, height);
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.#record("fillRect", x, y, width, height);
  }

  beginPath(): void {
    this.#record("beginPath");
  }

  moveTo(x: number, y: number): void {
    this.#record("moveTo", x, y);
  }

  lineTo(x: number, y: number): void {
    this.#record("lineTo", x, y);
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.#record("quadraticCurveTo", cpx, cpy, x, y);
  }

  closePath(): void {
    this.#record("closePath");
  }

  rect(x: number, y: number, width: number, height: number): void {
    this.#record("rect", x, y, width, height);
  }

  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number
  ): void {
    this.#record("ellipse", x, y, radiusX, radiusY, rotation, startAngle, endAngle);
  }

  fill(
    pathOrRule?: Canvas2DPathLike | "nonzero" | "evenodd",
    fillRule?: "nonzero" | "evenodd"
  ): void {
    this.#record("fill", pathOrRule, fillRule);
  }

  stroke(pathValue?: Canvas2DPathLike): void {
    this.#record("stroke", pathValue);
  }

  fillText(text: string, x: number, y: number): void {
    this.#record("fillText", text, x, y);
  }

  strokeText(text: string, x: number, y: number): void {
    this.#record("strokeText", text, x, y);
  }

  measureText(text: string): Canvas2DTextMetricsLike {
    this.#record("measureText", text);
    return {
      width: text.length * 10,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2
    };
  }

  isPointInPath(
    pathValue: Canvas2DPathLike,
    x: number,
    y: number,
    fillRule?: "nonzero" | "evenodd"
  ): boolean {
    this.#record("isPointInPath", pathValue, x, y, fillRule);
    return true;
  }

  isPointInStroke(pathValue: Canvas2DPathLike, x: number, y: number): boolean {
    this.#record("isPointInStroke", pathValue, x, y);
    return false;
  }
}

async function loadGraph(project: string, sample: string): Promise<ResolvedPresentationGraph> {
  const source = await readFile(
    path.join(goldenRoot, project, "expected", `${sample}.graph.json`),
    "utf8"
  );
  const graph: unknown = JSON.parse(source);
  expect(validatePresentationGraph(graph)).toEqual([]);
  return graph as ResolvedPresentationGraph;
}

async function loadSvg(project: string, sample: string): Promise<string> {
  return readFile(path.join(goldenRoot, project, "expected", `${sample}.svg`), "utf8");
}

function canvasSurface(context: TraceContext, paths: string[]) {
  return {
    surfaceType: CANVAS2D_SURFACE_TYPE,
    width: 1920,
    height: 1080,
    pixelRatio: 1,
    resource: {
      context,
      createPath2D(data: string): TracePath {
        paths.push(data);
        return { data };
      }
    }
  };
}

const samples = [
  ["core-static-scene", "t0000"],
  ["animated-signals", "t0000-default"],
  ["animated-signals", "t2500-external"],
  ["animated-signals", "t5000-default"],
  ["transforms-visibility", "t0000"],
  ["motion-authoring", "t0000"],
  ["motion-authoring", "t2000"],
  ["motion-authoring", "t3500"],
  ["motion-authoring", "t5000"]
] as const;

describe("official renderer conformance", () => {
  it.each(samples)("keeps %s/%s valid and byte-stable through SVG", async (project, sample) => {
    const graph = await loadGraph(project, sample);
    const artifact = await svgRendererProvider.renderOutput({
      graph,
      target: SVG_OUTPUT_TARGET,
      settings: {}
    });

    expect(artifact.kind).toBe("text");
    if (artifact.kind === "text") {
      expect(artifact.text).toBe(await loadSvg(project, sample));
    }
  });

  it("draws every standard leaf and preserves reverse paint order in Canvas2D", async () => {
    const graph = await loadGraph("animated-signals", "t0000-default");
    const context = new TraceContext();
    const paths: string[] = [];
    const session = await canvas2dRendererProvider.openSession({
      graph,
      surface: canvasSurface(context, paths),
      settings: {}
    });

    expect(context.operations()).toEqual(
      expect.arrayContaining([
        "fillRect",
        "quadraticCurveTo",
        "ellipse",
        "fill",
        "stroke",
        "fillText"
      ])
    );
    expect(paths).toEqual(["M 0 -72 L 62 0 L 0 72 L -62 0 Z"]);
    expect(await session.hitTest({ x: 960, y: 430, mode: "all" })).toEqual([
      expect.objectContaining({
        presentationId: "node_mark",
        sourceResourceUri: "kw://project/document/document_main/node/node_mark"
      }),
      expect.objectContaining({
        presentationId: "node_panel",
        sourceResourceUri: "kw://project/document/document_main/node/node_panel"
      })
    ]);
    await session.dispose();
  });

  it("retains hidden nodes in SVG and suppresses their Canvas2D draw and hit records", async () => {
    const graph = await loadGraph("transforms-visibility", "t0000");
    const artifact = await svgRendererProvider.renderOutput({
      graph,
      target: SVG_OUTPUT_TARGET,
      settings: {}
    });
    expect(artifact.kind).toBe("text");
    if (artifact.kind === "text") {
      expect(artifact.text).toContain('<rect id="node_panel"');
      expect(artifact.text).toContain('display="none"');
      expect(artifact.text).toContain('<ellipse id="node_orbit"');
      expect(artifact.text).toContain('opacity="0"');
      expect(artifact.text).toContain('<g id="node_cluster"');
      expect(artifact.text).toContain('opacity="0.64"');
    }

    const context = new TraceContext();
    const paths: string[] = [];
    const session = await canvas2dRendererProvider.openSession({
      graph,
      surface: canvasSurface(context, paths),
      settings: {}
    });
    expect(context.operations()).not.toContain("quadraticCurveTo");
    expect(context.operations()).not.toContain("ellipse");
    expect(context.operations()).toContain("fillText");
    expect(paths).toEqual(["M 0 -72 L 62 0 L 0 72 L -62 0 Z"]);
    const hitIds = (await session.hitTest({ x: 960, y: 540, mode: "all" })).map(
      (hit) => hit.presentationId
    );
    expect(hitIds).not.toContain("node_panel");
    expect(hitIds).not.toContain("node_orbit");
    await session.dispose();
  });
});
