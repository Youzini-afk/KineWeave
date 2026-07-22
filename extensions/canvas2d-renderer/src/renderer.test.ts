import { describe, expect, it, vi } from "vitest";
import {
  PRESENTATION_GRAPH_VERSION,
  STANDARD_COLOR_SPACES,
  STANDARD_PRESENTATION_PRIMITIVES,
  STANDARD_TIME_DOMAINS,
  rational,
  timeValue,
  type ResolvedPresentationGraph
} from "@kineweave/protocol";
import { CANVAS2D_SURFACE_TYPE } from "./descriptor.js";
import {
  canvas2dRendererProvider,
  type Canvas2DContextLike,
  type Canvas2DPathLike,
  type Canvas2DTextMetricsLike
} from "./renderer.js";

interface FakePath extends Canvas2DPathLike {
  readonly data: string;
}

class FakeContext implements Canvas2DContextLike {
  globalAlpha = 1;
  fillStyle: unknown = "#000000";
  strokeStyle: unknown = "#000000";
  lineWidth = 1;
  font = "10px sans-serif";
  textAlign = "start";
  textBaseline = "alphabetic";
  readonly calls: string[] = [];
  readonly transforms: number[][] = [];
  readonly clearRect = vi.fn(
    (_x: number, _y: number, _width: number, _height: number) => {}
  );

  save(): void {
    this.calls.push("save");
  }
  restore(): void {
    this.calls.push("restore");
  }
  setTransform(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number
  ): void {
    this.transforms.push([a, b, c, d, e, f]);
  }
  transform(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number
  ): void {
    this.transforms.push([a, b, c, d, e, f]);
  }
  fillRect(_x: number, _y: number, _width: number, _height: number): void {
    this.calls.push("fillRect");
  }
  beginPath(): void {
    this.calls.push("beginPath");
  }
  moveTo(_x: number, _y: number): void {}
  lineTo(_x: number, _y: number): void {}
  quadraticCurveTo(
    _cpx: number,
    _cpy: number,
    _x: number,
    _y: number
  ): void {}
  closePath(): void {}
  rect(_x: number, _y: number, _width: number, _height: number): void {}
  ellipse(
    _x: number,
    _y: number,
    _radiusX: number,
    _radiusY: number,
    _rotation: number,
    _startAngle: number,
    _endAngle: number
  ): void {
    this.calls.push("ellipse");
  }
  fill(
    _pathOrRule?: Canvas2DPathLike | "nonzero" | "evenodd",
    _fillRule?: "nonzero" | "evenodd"
  ): void {
    this.calls.push("fill");
  }
  stroke(_path?: Canvas2DPathLike): void {
    this.calls.push("stroke");
  }
  fillText(text: string, _x: number, _y: number): void {
    this.calls.push(`fillText:${text}`);
  }
  strokeText(text: string, _x: number, _y: number): void {
    this.calls.push(`strokeText:${text}`);
  }
  measureText(text: string): Canvas2DTextMetricsLike {
    return { width: text.length * 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 };
  }
  isPointInPath(
    _path: Canvas2DPathLike,
    x: number,
    y: number,
    _fillRule?: "nonzero" | "evenodd"
  ): boolean {
    return Math.abs(x) <= 20 && Math.abs(y) <= 20;
  }
  isPointInStroke(_path: Canvas2DPathLike, _x: number, _y: number): boolean {
    return false;
  }
}

function graph(pathVisible = true): ResolvedPresentationGraph {
  return {
    presentationGraphVersion: PRESENTATION_GRAPH_VERSION,
    documentId: "document_main",
    time: timeValue(rational(0), STANDARD_TIME_DOMAINS.seconds),
    viewport: { width: 400, height: 200, pixelRatio: rational(1) },
    colorSpace: STANDARD_COLOR_SPACES.srgb,
    background: "#10131a",
    rootNodeIds: ["node_group"],
    nodes: {
      node_group: {
        presentationId: "node_group",
        primitive: STANDARD_PRESENTATION_PRIMITIVES.group,
        children: ["node_rectangle", "node_ellipse", "node_path"],
        visible: true,
        opacity: 0.8,
        transform: {
          translation: [100, 50],
          scale: [1, 1],
          rotation: 0,
          anchor: [0, 0]
        },
        data: {}
      },
      node_rectangle: {
        presentationId: "node_rectangle",
        primitive: STANDARD_PRESENTATION_PRIMITIVES.rectangle,
        children: [],
        visible: true,
        opacity: 1,
        transform: {
          translation: [0, 0],
          scale: [1, 1],
          rotation: 0,
          anchor: [0, 0]
        },
        sourceResourceUri:
          "kw://project/document/document_main/node/node_rectangle",
        data: {
          width: 100,
          height: 50,
          cornerRadius: 8,
          fill: "#ff0000",
          stroke: "#ffffff",
          strokeWidth: 2
        }
      },
      node_ellipse: {
        presentationId: "node_ellipse",
        primitive: STANDARD_PRESENTATION_PRIMITIVES.ellipse,
        children: [],
        visible: true,
        opacity: 1,
        transform: {
          translation: [0, 0],
          scale: [1, 1],
          rotation: 0,
          anchor: [0, 0]
        },
        data: {
          radiusX: 30,
          radiusY: 20,
          fill: "#00ff00",
          stroke: "#00000000",
          strokeWidth: 0
        }
      },
      node_path: {
        presentationId: "node_path",
        primitive: STANDARD_PRESENTATION_PRIMITIVES.path,
        children: [],
        visible: pathVisible,
        opacity: 1,
        transform: {
          translation: [0, 0],
          scale: [1, 1],
          rotation: 0,
          anchor: [0, 0]
        },
        data: {
          path: "M 0 -20 L 20 20 L -20 20 Z",
          fill: "#0000ff",
          stroke: "#00000000",
          strokeWidth: 0
        }
      }
    },
    requiredFeatures: [
      STANDARD_PRESENTATION_PRIMITIVES.group,
      STANDARD_PRESENTATION_PRIMITIVES.rectangle,
      STANDARD_PRESENTATION_PRIMITIVES.ellipse,
      STANDARD_PRESENTATION_PRIMITIVES.path,
      STANDARD_COLOR_SPACES.srgb
    ],
    metadata: { compositionCanvas: { width: 200, height: 100 } }
  };
}

function setup() {
  const context = new FakeContext();
  const createdPaths: string[] = [];
  const surface = {
    surfaceType: CANVAS2D_SURFACE_TYPE,
    width: 400,
    height: 200,
    pixelRatio: 2,
    resource: {
      context,
      createPath2D(pathData: string): FakePath {
        createdPaths.push(pathData);
        return { data: pathData };
      }
    }
  };
  return { context, createdPaths, surface };
}

describe("Canvas2D renderer", () => {
  it("draws a fitted high-DPI frame and returns reverse-paint-order hits", async () => {
    const { context, createdPaths, surface } = setup();
    const session = await canvas2dRendererProvider.openSession({
      graph: graph(),
      surface,
      settings: {}
    });

    expect(context.transforms).toContainEqual([4, 0, 0, 4, 0, 0]);
    expect(context.calls).toEqual(
      expect.arrayContaining(["fillRect", "ellipse", "fill"])
    );
    expect(createdPaths).toEqual(["M 0 -20 L 20 20 L -20 20 Z"]);
    expect(await session.hitTest({ x: 200, y: 100, mode: "all" })).toEqual([
      expect.objectContaining({ presentationId: "node_path", localPoint: [0, 0] }),
      expect.objectContaining({ presentationId: "node_ellipse", localPoint: [0, 0] }),
      expect.objectContaining({
        presentationId: "node_rectangle",
        sourceResourceUri:
          "kw://project/document/document_main/node/node_rectangle",
        localPoint: [0, 0]
      })
    ]);
  });

  it("refreshes hit records on frame update and surface resize", async () => {
    const { context, surface } = setup();
    const session = await canvas2dRendererProvider.openSession({
      graph: graph(),
      surface,
      settings: {}
    });
    await session.renderFrame({ graph: graph(false), dirtyPresentationIds: ["node_path"] });
    expect(await session.hitTest({ x: 200, y: 100 })).toEqual([
      expect.objectContaining({ presentationId: "node_ellipse" })
    ]);

    await session.resize({ ...surface, width: 600, height: 300 });
    expect(await session.hitTest({ x: 300, y: 150 })).toEqual([
      expect.objectContaining({ presentationId: "node_ellipse" })
    ]);
    await session.dispose();
    expect(context.clearRect).toHaveBeenLastCalledWith(0, 0, 1200, 600);
  });

  it("rejects an opaque surface resource that is not a Canvas2D adapter", () => {
    expect(() =>
      canvas2dRendererProvider.openSession({
        graph: graph(),
        surface: {
          surfaceType: CANVAS2D_SURFACE_TYPE,
          width: 100,
          height: 100,
          pixelRatio: 1,
          resource: {}
        },
        settings: {}
      })
    ).toThrow(/context resource/i);
  });
});
