import {
  STANDARD_PRESENTATION_PRIMITIVES,
  type JsonObject,
  type PresentationNode,
  type ResolvedPresentationGraph
} from "@kineweave/protocol";
import type {
  InteractiveHit,
  InteractiveHitTestRequest,
  InteractiveRenderSurface,
  InteractiveRendererFrameRequest,
  InteractiveRendererInstance,
  InteractiveRendererProvider
} from "@kineweave/render-engine";
import {
  CANVAS2D_SURFACE_TYPE,
  canvas2dRendererDescriptor
} from "./descriptor.js";

export interface Canvas2DPathLike {
  readonly __kineweaveCanvas2dPathBrand?: never;
}

export interface Canvas2DTextMetricsLike {
  readonly width: number;
  readonly actualBoundingBoxAscent?: number;
  readonly actualBoundingBoxDescent?: number;
}

/** The Canvas 2D subset used by KineWeave; DOM and non-DOM hosts can adapt it. */
export interface Canvas2DContextLike {
  globalAlpha: number;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  closePath(): void;
  rect(x: number, y: number, width: number, height: number): void;
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number
  ): void;
  fill(pathOrRule?: Canvas2DPathLike | "nonzero" | "evenodd", fillRule?: "nonzero" | "evenodd"): void;
  stroke(path?: Canvas2DPathLike): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  measureText(text: string): Canvas2DTextMetricsLike;
  isPointInPath(
    path: Canvas2DPathLike,
    x: number,
    y: number,
    fillRule?: "nonzero" | "evenodd"
  ): boolean;
  isPointInStroke(path: Canvas2DPathLike, x: number, y: number): boolean;
}

export interface Canvas2DSurfaceResource {
  readonly context: Canvas2DContextLike;
  readonly createPath2D: (pathData: string) => Canvas2DPathLike;
}

type Matrix = readonly [number, number, number, number, number, number];

interface DrawRecordBase {
  readonly presentationId: string;
  readonly sourceResourceUri?: string;
  readonly inverseWorld: Matrix | undefined;
  readonly fillEnabled: boolean;
  readonly strokeWidth: number;
}

interface RectangleDrawRecord extends DrawRecordBase {
  readonly kind: "rectangle";
  readonly width: number;
  readonly height: number;
  readonly cornerRadius: number;
}

interface EllipseDrawRecord extends DrawRecordBase {
  readonly kind: "ellipse";
  readonly radiusX: number;
  readonly radiusY: number;
}

interface TextDrawRecord extends DrawRecordBase {
  readonly kind: "text";
  readonly width: number;
  readonly height: number;
}

interface PathDrawRecord extends DrawRecordBase {
  readonly kind: "path";
  readonly path: Canvas2DPathLike;
}

type DrawRecord =
  | RectangleDrawRecord
  | EllipseDrawRecord
  | TextDrawRecord
  | PathDrawRecord;

const REQUIRED_CONTEXT_METHODS = [
  "save",
  "restore",
  "setTransform",
  "transform",
  "clearRect",
  "fillRect",
  "beginPath",
  "moveTo",
  "lineTo",
  "quadraticCurveTo",
  "closePath",
  "rect",
  "ellipse",
  "fill",
  "stroke",
  "fillText",
  "strokeText",
  "measureText",
  "isPointInPath",
  "isPointInStroke"
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function surfaceResource(surface: InteractiveRenderSurface): Canvas2DSurfaceResource {
  if (surface.surfaceType !== CANVAS2D_SURFACE_TYPE) {
    throw new TypeError(`Canvas2D renderer requires ${CANVAS2D_SURFACE_TYPE}`);
  }
  if (!isRecord(surface.resource) || !isRecord(surface.resource.context)) {
    throw new TypeError("Canvas2D surface requires a context resource");
  }
  for (const method of REQUIRED_CONTEXT_METHODS) {
    if (typeof surface.resource.context[method] !== "function") {
      throw new TypeError(`Canvas2D context is missing ${method}()`);
    }
  }
  if (typeof surface.resource.createPath2D !== "function") {
    throw new TypeError("Canvas2D surface requires createPath2D()");
  }
  return surface.resource as unknown as Canvas2DSurfaceResource;
}

function multiply(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5]
  ];
}

function inverse(matrix: Matrix): Matrix | undefined {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    return undefined;
  }
  return [
    matrix[3] / determinant,
    -matrix[1] / determinant,
    -matrix[2] / determinant,
    matrix[0] / determinant,
    (matrix[2] * matrix[5] - matrix[3] * matrix[4]) / determinant,
    (matrix[1] * matrix[4] - matrix[0] * matrix[5]) / determinant
  ];
}

function transformPoint(matrix: Matrix, x: number, y: number): [number, number] {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5]
  ];
}

function nodeMatrix(node: PresentationNode): Matrix {
  const radians = (node.transform.rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const [scaleX, scaleY] = node.transform.scale;
  const [anchorX, anchorY] = node.transform.anchor;
  const [translationX, translationY] = node.transform.translation;
  const transform: Matrix = [
    cosine * scaleX!,
    sine * scaleX!,
    -sine * scaleY!,
    cosine * scaleY!,
    translationX!,
    translationY!
  ];
  return multiply(transform, [1, 0, 0, 1, -anchorX!, -anchorY!]);
}

function numberData(data: JsonObject, key: string, fallback?: number): number {
  const value = data[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Canvas2D primitive requires finite numeric ${key}`);
  }
  return value;
}

function stringData(data: JsonObject, key: string, fallback?: string): string {
  const value = data[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") {
    throw new TypeError(`Canvas2D primitive requires string ${key}`);
  }
  return value;
}

function compositionSize(graph: ResolvedPresentationGraph): {
  readonly width: number;
  readonly height: number;
} {
  const canvas = graph.metadata?.compositionCanvas;
  if (isRecord(canvas)) {
    const { width, height } = canvas;
    if (
      typeof width === "number" &&
      Number.isFinite(width) &&
      width > 0 &&
      typeof height === "number" &&
      Number.isFinite(height) &&
      height > 0
    ) {
      return { width, height };
    }
  }
  return { width: graph.viewport.width, height: graph.viewport.height };
}

function viewportMatrix(
  surface: InteractiveRenderSurface,
  composition: { readonly width: number; readonly height: number }
): Matrix {
  const scale = Math.min(
    surface.width / composition.width,
    surface.height / composition.height
  );
  return [
    scale,
    0,
    0,
    scale,
    (surface.width - composition.width * scale) / 2,
    (surface.height - composition.height * scale) / 2
  ];
}

function transparent(color: string): boolean {
  const normalized = color.trim().toLowerCase();
  return (
    normalized === "transparent" ||
    /^#[0-9a-f]{6}00$/.test(normalized)
  );
}

function shapeStyle(
  context: Canvas2DContextLike,
  data: JsonObject
): { readonly fillEnabled: boolean; readonly strokeWidth: number } {
  const fill = stringData(data, "fill", "#00000000");
  const stroke = stringData(data, "stroke", "#00000000");
  const strokeWidth = numberData(data, "strokeWidth", 0);
  context.fillStyle = fill;
  context.strokeStyle = stroke;
  context.lineWidth = strokeWidth;
  return {
    fillEnabled: !transparent(fill),
    strokeWidth: transparent(stroke) ? 0 : strokeWidth
  };
}

function roundedRectanglePath(
  context: Canvas2DContextLike,
  width: number,
  height: number,
  requestedRadius: number
): void {
  const x = -width / 2;
  const y = -height / 2;
  const radius = Math.min(requestedRadius, width / 2, height / 2);
  context.beginPath();
  if (radius <= 0) {
    context.rect(x, y, width, height);
    return;
  }
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - radius,
    y + height
  );
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function drawStyledPath(
  context: Canvas2DContextLike,
  style: { readonly fillEnabled: boolean; readonly strokeWidth: number },
  path?: Canvas2DPathLike
): void {
  if (style.fillEnabled) {
    if (path === undefined) context.fill();
    else context.fill(path);
  }
  if (style.strokeWidth > 0) {
    if (path === undefined) context.stroke();
    else context.stroke(path);
  }
}

function recordBase(
  node: PresentationNode,
  world: Matrix,
  style: { readonly fillEnabled: boolean; readonly strokeWidth: number }
): DrawRecordBase {
  return {
    presentationId: node.presentationId,
    ...(node.sourceResourceUri === undefined
      ? {}
      : { sourceResourceUri: node.sourceResourceUri }),
    inverseWorld: inverse(world),
    fillEnabled: style.fillEnabled,
    strokeWidth: style.strokeWidth
  };
}

function drawNode(
  graph: ResolvedPresentationGraph,
  nodeId: string,
  parentWorld: Matrix,
  resource: Canvas2DSurfaceResource,
  records: DrawRecord[]
): void {
  const node = graph.nodes[nodeId];
  if (node === undefined) throw new Error(`Missing presentation node ${nodeId}`);
  if (!node.visible || node.opacity <= 0) return;
  const local = nodeMatrix(node);
  const world = multiply(parentWorld, local);
  const context = resource.context;
  context.save();
  try {
    context.transform(...local);
    context.globalAlpha *= node.opacity;
    if (node.primitive === STANDARD_PRESENTATION_PRIMITIVES.group) {
      for (const childId of node.children) {
        drawNode(graph, childId, world, resource, records);
      }
      return;
    }
    if (node.children.length > 0) {
      throw new Error(`Canvas2D leaf node ${nodeId} cannot contain child nodes`);
    }
    if (node.primitive === STANDARD_PRESENTATION_PRIMITIVES.rectangle) {
      const width = numberData(node.data, "width");
      const height = numberData(node.data, "height");
      const cornerRadius = numberData(node.data, "cornerRadius", 0);
      const style = shapeStyle(context, node.data);
      roundedRectanglePath(context, width, height, cornerRadius);
      drawStyledPath(context, style);
      records.push({
        ...recordBase(node, world, style),
        kind: "rectangle",
        width,
        height,
        cornerRadius
      });
      return;
    }
    if (node.primitive === STANDARD_PRESENTATION_PRIMITIVES.ellipse) {
      const radiusX = numberData(node.data, "radiusX");
      const radiusY = numberData(node.data, "radiusY");
      const style = shapeStyle(context, node.data);
      context.beginPath();
      context.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2);
      drawStyledPath(context, style);
      records.push({
        ...recordBase(node, world, style),
        kind: "ellipse",
        radiusX,
        radiusY
      });
      return;
    }
    if (node.primitive === STANDARD_PRESENTATION_PRIMITIVES.path) {
      const path = resource.createPath2D(stringData(node.data, "path"));
      const style = shapeStyle(context, node.data);
      drawStyledPath(context, style, path);
      records.push({ ...recordBase(node, world, style), kind: "path", path });
      return;
    }
    if (node.primitive === STANDARD_PRESENTATION_PRIMITIVES.text) {
      const text = stringData(node.data, "text");
      const fontSize = numberData(node.data, "fontSize");
      const fontFamily = stringData(node.data, "fontFamily", "sans-serif");
      const fill = stringData(node.data, "fill", "#000000");
      const stroke = stringData(node.data, "stroke", "#00000000");
      const strokeWidth = numberData(node.data, "strokeWidth", 0);
      context.font = `${fontSize}px ${fontFamily}`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = fill;
      context.strokeStyle = stroke;
      context.lineWidth = strokeWidth;
      const fillEnabled = !transparent(fill);
      const effectiveStrokeWidth = transparent(stroke) ? 0 : strokeWidth;
      if (fillEnabled) context.fillText(text, 0, 0);
      if (effectiveStrokeWidth > 0) context.strokeText(text, 0, 0);
      const metrics = context.measureText(text);
      const measuredHeight =
        (metrics.actualBoundingBoxAscent ?? fontSize / 2) +
        (metrics.actualBoundingBoxDescent ?? fontSize / 2);
      records.push({
        ...recordBase(node, world, {
          fillEnabled,
          strokeWidth: effectiveStrokeWidth
        }),
        kind: "text",
        width: metrics.width,
        height: measuredHeight
      });
      return;
    }
    throw new Error(`Canvas2D renderer does not support primitive ${node.primitive}`);
  } finally {
    context.restore();
  }
}

function insideRoundedRectangle(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): boolean {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  if (Math.abs(x) > halfWidth || Math.abs(y) > halfHeight) return false;
  const clampedRadius = Math.min(radius, halfWidth, halfHeight);
  if (
    Math.abs(x) <= halfWidth - clampedRadius ||
    Math.abs(y) <= halfHeight - clampedRadius
  ) {
    return true;
  }
  const cornerX = Math.abs(x) - (halfWidth - clampedRadius);
  const cornerY = Math.abs(y) - (halfHeight - clampedRadius);
  return cornerX * cornerX + cornerY * cornerY <= clampedRadius * clampedRadius;
}

function recordHit(
  record: DrawRecord,
  localX: number,
  localY: number,
  resource: Canvas2DSurfaceResource
): boolean {
  const halfStroke = record.strokeWidth / 2;
  if (record.kind === "rectangle") {
    if (
      record.fillEnabled &&
      insideRoundedRectangle(
        localX,
        localY,
        record.width,
        record.height,
        record.cornerRadius
      )
    ) {
      return true;
    }
    if (record.strokeWidth <= 0) return false;
    const insideOuter = insideRoundedRectangle(
      localX,
      localY,
      record.width + record.strokeWidth,
      record.height + record.strokeWidth,
      record.cornerRadius + halfStroke
    );
    const innerWidth = record.width - record.strokeWidth;
    const innerHeight = record.height - record.strokeWidth;
    const insideInner =
      innerWidth > 0 &&
      innerHeight > 0 &&
      insideRoundedRectangle(
        localX,
        localY,
        innerWidth,
        innerHeight,
        Math.max(0, record.cornerRadius - halfStroke)
      );
    return insideOuter && !insideInner;
  }
  if (record.kind === "ellipse") {
    const outerX = record.radiusX + halfStroke;
    const outerY = record.radiusY + halfStroke;
    const normalizedOuter =
      (localX * localX) / (outerX * outerX) +
      (localY * localY) / (outerY * outerY);
    if (record.fillEnabled) {
      const normalizedFill =
        (localX * localX) / (record.radiusX * record.radiusX) +
        (localY * localY) / (record.radiusY * record.radiusY);
      if (normalizedFill <= 1) return true;
    }
    if (record.strokeWidth <= 0 || normalizedOuter > 1) return false;
    const innerX = record.radiusX - halfStroke;
    const innerY = record.radiusY - halfStroke;
    if (innerX <= 0 || innerY <= 0) return true;
    const normalizedInner =
      (localX * localX) / (innerX * innerX) +
      (localY * localY) / (innerY * innerY);
    return normalizedInner >= 1;
  }
  if (record.kind === "text") {
    return (
      Math.abs(localX) <= record.width / 2 + halfStroke &&
      Math.abs(localY) <= record.height / 2 + halfStroke
    );
  }
  const context = resource.context;
  context.save();
  try {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.lineWidth = record.strokeWidth;
    return (
      (record.fillEnabled && context.isPointInPath(record.path, localX, localY)) ||
      (record.strokeWidth > 0 &&
        context.isPointInStroke(record.path, localX, localY))
    );
  } finally {
    context.restore();
  }
}

class Canvas2DRendererSession implements InteractiveRendererInstance {
  #surface: InteractiveRenderSurface;
  #resource: Canvas2DSurfaceResource;
  #graph: ResolvedPresentationGraph;
  #records: DrawRecord[] = [];
  #disposed = false;

  constructor(
    surface: InteractiveRenderSurface,
    graph: ResolvedPresentationGraph
  ) {
    this.#surface = surface;
    this.#resource = surfaceResource(surface);
    this.#graph = graph;
    this.#draw();
  }

  renderFrame(request: InteractiveRendererFrameRequest): void {
    this.#assertOpen();
    this.#graph = request.graph;
    this.#draw();
  }

  resize(surface: InteractiveRenderSurface): void {
    this.#assertOpen();
    this.#surface = surface;
    this.#resource = surfaceResource(surface);
    this.#draw();
  }

  hitTest(request: InteractiveHitTestRequest): readonly InteractiveHit[] {
    this.#assertOpen();
    const hits: InteractiveHit[] = [];
    for (let index = this.#records.length - 1; index >= 0; index -= 1) {
      const record = this.#records[index]!;
      if (record.inverseWorld === undefined) continue;
      const localPoint = transformPoint(
        record.inverseWorld,
        request.x,
        request.y
      );
      if (!recordHit(record, localPoint[0], localPoint[1], this.#resource)) {
        continue;
      }
      hits.push({
        presentationId: record.presentationId,
        ...(record.sourceResourceUri === undefined
          ? {}
          : { sourceResourceUri: record.sourceResourceUri }),
        localPoint
      });
      if (request.mode !== "all") break;
    }
    return hits;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#clear();
    this.#records = [];
    this.#disposed = true;
  }

  #draw(): void {
    const context = this.#resource.context;
    const composition = compositionSize(this.#graph);
    const view = viewportMatrix(this.#surface, composition);
    this.#clear();
    this.#records = [];
    context.setTransform(
      this.#surface.pixelRatio * view[0],
      this.#surface.pixelRatio * view[1],
      this.#surface.pixelRatio * view[2],
      this.#surface.pixelRatio * view[3],
      this.#surface.pixelRatio * view[4],
      this.#surface.pixelRatio * view[5]
    );
    context.globalAlpha = 1;
    if (this.#graph.background !== null) {
      context.fillStyle = this.#graph.background;
      context.fillRect(0, 0, composition.width, composition.height);
    }
    for (const nodeId of this.#graph.rootNodeIds) {
      drawNode(this.#graph, nodeId, view, this.#resource, this.#records);
    }
  }

  #clear(): void {
    const context = this.#resource.context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(
      0,
      0,
      this.#surface.width * this.#surface.pixelRatio,
      this.#surface.height * this.#surface.pixelRatio
    );
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error("Canvas2D renderer session is disposed");
  }
}

export const canvas2dRendererProvider: InteractiveRendererProvider = {
  descriptor: canvas2dRendererDescriptor,
  openSession({ graph, surface }) {
    return new Canvas2DRendererSession(surface, graph);
  }
};
