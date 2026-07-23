import {
  type JsonValue,
  type PresentationNode,
  type ResolvedPresentationGraph,
  rationalToNumberLossy,
  STANDARD_PRESENTATION_PRIMITIVES
} from "@kineweave/protocol";
import {
  type MotionNode,
  type PropertyBinding,
  STANDARD_NODE_TYPES,
  type StandardCompositionDocument
} from "@kineweave/standard-motion-document";

export interface LayerItem {
  readonly node: MotionNode;
  readonly depth: number;
  readonly parentNodeId: string | null;
  readonly index: number;
}

export interface InspectorField {
  readonly property: string;
  readonly label: string;
  readonly kind: "text" | "multiline" | "number" | "boolean" | "color" | "vector2";
  readonly value: JsonValue | undefined;
  readonly bindingKind: string | undefined;
}

type Matrix = readonly [number, number, number, number, number, number];
type Point = readonly [number, number];

export function compositionDurationSeconds(document: StandardCompositionDocument): number {
  return rationalToNumberLossy(document.data.duration.value);
}

export function roundCompositionCoordinate(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function flattenLayerTree(document: StandardCompositionDocument): readonly LayerItem[] {
  const result: LayerItem[] = [];
  const visit = (
    nodeId: string,
    depth: number,
    parentNodeId: string | null,
    index: number
  ): void => {
    const node = document.data.nodes[nodeId];
    if (node === undefined) return;
    result.push({ node, depth, parentNodeId, index });
    node.children.forEach((childId, childIndex) => {
      visit(childId, depth + 1, nodeId, childIndex);
    });
  };
  document.data.rootNodeIds.forEach((nodeId, index) => {
    visit(nodeId, 0, null, index);
  });
  return result;
}

export function findLayerParent(
  document: StandardCompositionDocument,
  nodeId: string
): { readonly parentNodeId: string | null; readonly index: number } | undefined {
  const rootIndex = document.data.rootNodeIds.indexOf(nodeId);
  if (rootIndex !== -1) return { parentNodeId: null, index: rootIndex };
  for (const node of Object.values(document.data.nodes)) {
    const index = node.children.indexOf(nodeId);
    if (index !== -1) return { parentNodeId: node.nodeId, index };
  }
  return undefined;
}

export function constantBindingValue(binding: PropertyBinding | undefined): JsonValue | undefined {
  return binding?.kind === "constant" && "value" in binding ? binding.value : undefined;
}

function field(
  node: MotionNode,
  property: string,
  label: string,
  kind: InspectorField["kind"]
): InspectorField {
  const binding = node.properties[property];
  return {
    property,
    label,
    kind,
    value: constantBindingValue(binding),
    bindingKind: binding?.kind
  };
}

export function inspectorFields(node: MotionNode): readonly InspectorField[] {
  const result: InspectorField[] = [
    field(node, "position", "Position", "vector2"),
    field(node, "scale", "Scale", "vector2"),
    field(node, "rotation", "Rotation", "number"),
    field(node, "opacity", "Opacity", "number"),
    field(node, "visible", "Visible", "boolean")
  ];
  if (node.nodeType === STANDARD_NODE_TYPES.text) {
    result.push(
      field(node, "content", "Text", "text"),
      field(node, "fontSize", "Font size", "number"),
      field(node, "fill", "Fill", "color")
    );
  }
  if (
    node.nodeType === STANDARD_NODE_TYPES.rectangle ||
    node.nodeType === STANDARD_NODE_TYPES.ellipse
  ) {
    result.push(field(node, "size", "Size", "vector2"));
  }
  if (node.nodeType === STANDARD_NODE_TYPES.rectangle) {
    result.push(field(node, "cornerRadius", "Corner radius", "number"));
  }
  if (node.nodeType === STANDARD_NODE_TYPES.path) {
    result.push(field(node, "path", "Path data", "multiline"));
  }
  if (
    node.nodeType === STANDARD_NODE_TYPES.rectangle ||
    node.nodeType === STANDARD_NODE_TYPES.ellipse ||
    node.nodeType === STANDARD_NODE_TYPES.path
  ) {
    result.push(
      field(node, "fill", "Fill", "color"),
      field(node, "stroke", "Stroke", "color"),
      field(node, "strokeWidth", "Stroke width", "number")
    );
  }
  return result;
}

export function shortNodeType(nodeType: string): string {
  return nodeType.slice(nodeType.lastIndexOf("/") + 1);
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

function point(matrix: Matrix, value: Point): Point {
  return [
    matrix[0] * value[0] + matrix[2] * value[1] + matrix[4],
    matrix[1] * value[0] + matrix[3] * value[1] + matrix[5]
  ];
}

function nodeMatrix(node: PresentationNode): Matrix {
  const radians = (node.transform.rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const [scaleX = 1, scaleY = 1] = node.transform.scale;
  const [anchorX = 0, anchorY = 0] = node.transform.anchor;
  const [translationX = 0, translationY = 0] = node.transform.translation;
  return multiply(
    [cosine * scaleX, sine * scaleX, -sine * scaleY, cosine * scaleY, translationX, translationY],
    [1, 0, 0, 1, -anchorX, -anchorY]
  );
}

function graphCanvasSize(graph: ResolvedPresentationGraph): {
  readonly width: number;
  readonly height: number;
} {
  const value = graph.metadata?.compositionCanvas;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const width = value.width;
    const height = value.height;
    if (typeof width === "number" && width > 0 && typeof height === "number" && height > 0) {
      return { width, height };
    }
  }
  return { width: graph.viewport.width, height: graph.viewport.height };
}

function localBounds(node: PresentationNode): readonly Point[] {
  let halfWidth = 32;
  let halfHeight = 32;
  if (node.primitive === STANDARD_PRESENTATION_PRIMITIVES.rectangle) {
    halfWidth = typeof node.data.width === "number" ? node.data.width / 2 : halfWidth;
    halfHeight = typeof node.data.height === "number" ? node.data.height / 2 : halfHeight;
  } else if (node.primitive === STANDARD_PRESENTATION_PRIMITIVES.ellipse) {
    halfWidth = typeof node.data.radiusX === "number" ? node.data.radiusX : halfWidth;
    halfHeight = typeof node.data.radiusY === "number" ? node.data.radiusY : halfHeight;
  } else if (node.primitive === STANDARD_PRESENTATION_PRIMITIVES.text) {
    const text = typeof node.data.text === "string" ? node.data.text : "";
    const fontSize = typeof node.data.fontSize === "number" ? node.data.fontSize : 16;
    halfWidth = Math.max(fontSize / 2, (text.length * fontSize * 0.58) / 2);
    halfHeight = fontSize / 2;
  } else if (node.primitive === STANDARD_PRESENTATION_PRIMITIVES.path) {
    const pathData = typeof node.data.path === "string" ? node.data.path : "";
    const values = [...pathData.matchAll(/-?(?:\d+\.?\d*|\.\d+)/g)].map((match) =>
      Number(match[0])
    );
    const xs = values.filter((_value, index) => index % 2 === 0);
    const ys = values.filter((_value, index) => index % 2 === 1);
    if (xs.length > 0 && ys.length > 0) {
      halfWidth = Math.max(...xs.map(Math.abs), 1);
      halfHeight = Math.max(...ys.map(Math.abs), 1);
    }
  }
  return [
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight]
  ];
}

function parentMap(graph: ResolvedPresentationGraph): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const node of Object.values(graph.nodes)) {
    for (const childId of node.children) result.set(childId, node.presentationId);
  }
  return result;
}

function worldMatrix(
  graph: ResolvedPresentationGraph,
  nodeId: string,
  parents: ReadonlyMap<string, string>,
  cache: Map<string, Matrix>
): Matrix | undefined {
  const cached = cache.get(nodeId);
  if (cached !== undefined) return cached;
  const node = graph.nodes[nodeId];
  if (node === undefined) return undefined;
  const parentId = parents.get(nodeId);
  const matrix =
    parentId === undefined
      ? nodeMatrix(node)
      : multiply(
          worldMatrix(graph, parentId, parents, cache) ?? [1, 0, 0, 1, 0, 0],
          nodeMatrix(node)
        );
  cache.set(nodeId, matrix);
  return matrix;
}

export function selectionPolygon(
  graph: ResolvedPresentationGraph,
  nodeId: string,
  surface: { readonly width: number; readonly height: number }
): readonly Point[] | undefined {
  const selected = graph.nodes[nodeId];
  if (selected === undefined) return undefined;
  const canvas = graphCanvasSize(graph);
  const scale = Math.min(surface.width / canvas.width, surface.height / canvas.height);
  const view: Matrix = [
    scale,
    0,
    0,
    scale,
    (surface.width - canvas.width * scale) / 2,
    (surface.height - canvas.height * scale) / 2
  ];
  const parents = parentMap(graph);
  const cache = new Map<string, Matrix>();
  const collect = (currentId: string): Point[] => {
    const node = graph.nodes[currentId];
    if (node === undefined || !node.visible) return [];
    if (node.primitive === STANDARD_PRESENTATION_PRIMITIVES.group) {
      return node.children.flatMap((childId) => collect(childId));
    }
    const world = worldMatrix(graph, currentId, parents, cache);
    if (world === undefined) return [];
    const surfaceMatrix = multiply(view, world);
    return localBounds(node).map((corner) => point(surfaceMatrix, corner));
  };
  const points = collect(nodeId);
  if (points.length === 0) return undefined;
  if (selected.primitive !== STANDARD_PRESENTATION_PRIMITIVES.group) {
    return points.slice(0, 4);
  }
  const xs = points.map((item) => item[0]);
  const ys = points.map((item) => item[1]);
  const minimumX = Math.min(...xs);
  const maximumX = Math.max(...xs);
  const minimumY = Math.min(...ys);
  const maximumY = Math.max(...ys);
  return [
    [minimumX, minimumY],
    [maximumX, minimumY],
    [maximumX, maximumY],
    [minimumX, maximumY]
  ];
}
