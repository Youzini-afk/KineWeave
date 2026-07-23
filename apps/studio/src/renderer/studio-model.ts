import {
  type JsonValue,
  type PresentationNode,
  type ResolvedPresentationGraph,
  rationalToNumberLossy,
  STANDARD_PRESENTATION_PRIMITIVES
} from "@kineweave/protocol";
import {
  expectedStandardPropertyValueType,
  type Keyframe,
  type MotionNode,
  type PropertyBinding,
  type PropertyTrack,
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

export interface TimelineProperty {
  readonly property: string;
  readonly label: string;
  readonly valueType: string;
  readonly bindingKind: string | undefined;
  readonly track: PropertyTrack | undefined;
}

type Matrix = readonly [number, number, number, number, number, number];
export type StagePoint = readonly [number, number];

export interface StageSelectionBounds {
  readonly minimumX: number;
  readonly minimumY: number;
  readonly maximumX: number;
  readonly maximumY: number;
  readonly width: number;
  readonly height: number;
  readonly center: StagePoint;
  readonly polygon: readonly StagePoint[];
}

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

export function defaultPropertyValue(property: string): JsonValue {
  if (property === "position" || property === "anchor") return [0, 0];
  if (property === "scale") return [1, 1];
  if (property === "opacity") return 1;
  if (property === "visible") return true;
  if (property === "rotation" || property === "strokeWidth" || property === "cornerRadius") {
    return 0;
  }
  return "";
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

export function timelineProperties(
  document: StandardCompositionDocument,
  nodeId: string
): readonly TimelineProperty[] {
  const node = document.data.nodes[nodeId];
  if (node === undefined) return [];
  return inspectorFields(node).flatMap((item) => {
    const valueType = expectedStandardPropertyValueType(node.nodeType, item.property);
    if (valueType === undefined) return [];
    const binding = node.properties[item.property];
    const track =
      binding?.kind === "track" && typeof binding.trackId === "string"
        ? document.data.tracks[binding.trackId]
        : undefined;
    return [
      {
        property: item.property,
        label: item.label,
        valueType,
        bindingKind: binding?.kind,
        track
      }
    ];
  });
}

export function keyframeSeconds(keyframe: Keyframe): number {
  return rationalToNumberLossy(keyframe.time.value);
}

export function sortedKeyframes(track: PropertyTrack): readonly Keyframe[] {
  return Object.values(track.keyframes).sort((left, right) => {
    const timeDifference = keyframeSeconds(left) - keyframeSeconds(right);
    return timeDifference === 0 ? left.keyframeId.localeCompare(right.keyframeId) : timeDifference;
  });
}

export function resolvedPropertyValue(
  graph: ResolvedPresentationGraph | undefined,
  node: MotionNode,
  property: string
): JsonValue | undefined {
  const presentation = graph?.nodes[node.nodeId];
  if (presentation === undefined) return constantBindingValue(node.properties[property]);
  if (property === "position") return [...presentation.transform.translation];
  if (property === "scale") return [...presentation.transform.scale];
  if (property === "anchor") return [...presentation.transform.anchor];
  if (property === "rotation") return presentation.transform.rotation;
  if (property === "opacity") return presentation.opacity;
  if (property === "visible") return presentation.visible;
  if (property === "content") return presentation.data.text;
  if (property === "path") return presentation.data.path;
  if (property === "size") {
    if (node.nodeType === STANDARD_NODE_TYPES.ellipse) {
      const radiusX = presentation.data.radiusX;
      const radiusY = presentation.data.radiusY;
      return typeof radiusX === "number" && typeof radiusY === "number"
        ? [radiusX * 2, radiusY * 2]
        : undefined;
    }
    const width = presentation.data.width;
    const height = presentation.data.height;
    return typeof width === "number" && typeof height === "number" ? [width, height] : undefined;
  }
  return presentation.data[property];
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

function point(matrix: Matrix, value: StagePoint): StagePoint {
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

function localBounds(node: PresentationNode): readonly StagePoint[] {
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

function nodeIsEffectivelyVisible(
  graph: ResolvedPresentationGraph,
  nodeId: string,
  parents: ReadonlyMap<string, string>
): boolean {
  const visited = new Set<string>();
  let currentId: string | undefined = nodeId;
  while (currentId !== undefined) {
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    const node = graph.nodes[currentId];
    if (node === undefined || !node.visible) return false;
    currentId = parents.get(currentId);
  }
  return true;
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
): readonly StagePoint[] | undefined {
  const selected = graph.nodes[nodeId];
  if (selected === undefined) return undefined;
  const view = graphViewMatrix(graph, surface);
  const parents = parentMap(graph);
  if (!nodeIsEffectivelyVisible(graph, nodeId, parents)) return undefined;
  const cache = new Map<string, Matrix>();
  const collect = (currentId: string): StagePoint[] => {
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

function graphViewMatrix(
  graph: ResolvedPresentationGraph,
  surface: { readonly width: number; readonly height: number }
): Matrix {
  const canvas = graphCanvasSize(graph);
  const scale = Math.min(surface.width / canvas.width, surface.height / canvas.height);
  return [
    scale,
    0,
    0,
    scale,
    (surface.width - canvas.width * scale) / 2,
    (surface.height - canvas.height * scale) / 2
  ];
}

export function compositionSurfaceBounds(
  graph: ResolvedPresentationGraph,
  surface: { readonly width: number; readonly height: number }
): StageSelectionBounds {
  const canvas = graphCanvasSize(graph);
  const view = graphViewMatrix(graph, surface);
  const topLeft = point(view, [0, 0]);
  const bottomRight = point(view, [canvas.width, canvas.height]);
  const polygon: readonly StagePoint[] = [
    topLeft,
    [bottomRight[0], topLeft[1]],
    bottomRight,
    [topLeft[0], bottomRight[1]]
  ];
  return {
    minimumX: topLeft[0],
    minimumY: topLeft[1],
    maximumX: bottomRight[0],
    maximumY: bottomRight[1],
    width: bottomRight[0] - topLeft[0],
    height: bottomRight[1] - topLeft[1],
    center: [(topLeft[0] + bottomRight[0]) / 2, (topLeft[1] + bottomRight[1]) / 2],
    polygon
  };
}

function inverseLinear(matrix: Matrix): Matrix | undefined {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (Math.abs(determinant) < 1e-12) return undefined;
  return [
    matrix[3] / determinant,
    -matrix[1] / determinant,
    -matrix[2] / determinant,
    matrix[0] / determinant,
    0,
    0
  ];
}

function delta(matrix: Matrix, value: StagePoint): StagePoint {
  return [matrix[0] * value[0] + matrix[2] * value[1], matrix[1] * value[0] + matrix[3] * value[1]];
}

export function selectionBounds(
  graph: ResolvedPresentationGraph,
  nodeIds: readonly string[],
  surface: { readonly width: number; readonly height: number }
): StageSelectionBounds | undefined {
  const points = nodeIds.flatMap((nodeId) => selectionPolygon(graph, nodeId, surface) ?? []);
  if (points.length === 0) return undefined;
  const xs = points.map((item) => item[0]);
  const ys = points.map((item) => item[1]);
  const minimumX = Math.min(...xs);
  const maximumX = Math.max(...xs);
  const minimumY = Math.min(...ys);
  const maximumY = Math.max(...ys);
  const polygon: readonly StagePoint[] = [
    [minimumX, minimumY],
    [maximumX, minimumY],
    [maximumX, maximumY],
    [minimumX, maximumY]
  ];
  return {
    minimumX,
    minimumY,
    maximumX,
    maximumY,
    width: maximumX - minimumX,
    height: maximumY - minimumY,
    center: [(minimumX + maximumX) / 2, (minimumY + maximumY) / 2],
    polygon
  };
}

export function nodeAnchorSurfacePoint(
  graph: ResolvedPresentationGraph,
  nodeId: string,
  surface: { readonly width: number; readonly height: number }
): StagePoint | undefined {
  const node = graph.nodes[nodeId];
  if (node === undefined) return undefined;
  const parents = parentMap(graph);
  const world = worldMatrix(graph, nodeId, parents, new Map());
  if (world === undefined) return undefined;
  return point(multiply(graphViewMatrix(graph, surface), world), [
    node.transform.anchor[0] ?? 0,
    node.transform.anchor[1] ?? 0
  ]);
}

export function surfaceDeltaToParentDelta(
  graph: ResolvedPresentationGraph,
  nodeId: string,
  surface: { readonly width: number; readonly height: number },
  surfaceDelta: StagePoint
): StagePoint | undefined {
  if (graph.nodes[nodeId] === undefined) return undefined;
  const parents = parentMap(graph);
  const parentId = parents.get(nodeId);
  const parentWorld =
    parentId === undefined
      ? ([1, 0, 0, 1, 0, 0] as const)
      : worldMatrix(graph, parentId, parents, new Map());
  if (parentWorld === undefined) return undefined;
  const inverse = inverseLinear(multiply(graphViewMatrix(graph, surface), parentWorld));
  return inverse === undefined ? undefined : delta(inverse, surfaceDelta);
}

export function surfaceDeltaToLocalDelta(
  graph: ResolvedPresentationGraph,
  nodeId: string,
  surface: { readonly width: number; readonly height: number },
  surfaceDelta: StagePoint
): StagePoint | undefined {
  const parents = parentMap(graph);
  const world = worldMatrix(graph, nodeId, parents, new Map());
  if (world === undefined) return undefined;
  const inverse = inverseLinear(multiply(graphViewMatrix(graph, surface), world));
  return inverse === undefined ? undefined : delta(inverse, surfaceDelta);
}

export function stageRotationDirection(
  graph: ResolvedPresentationGraph,
  nodeId: string
): 1 | -1 | undefined {
  if (graph.nodes[nodeId] === undefined) return undefined;
  const parents = parentMap(graph);
  const parentId = parents.get(nodeId);
  const parentWorld =
    parentId === undefined
      ? ([1, 0, 0, 1, 0, 0] as const)
      : worldMatrix(graph, parentId, parents, new Map());
  if (parentWorld === undefined) return undefined;
  const firstLength = Math.hypot(parentWorld[0], parentWorld[1]);
  const secondLength = Math.hypot(parentWorld[2], parentWorld[3]);
  if (firstLength < 1e-9 || secondLength < 1e-9) return undefined;
  const scale = Math.max(firstLength, secondLength);
  const dot = parentWorld[0] * parentWorld[2] + parentWorld[1] * parentWorld[3];
  if (
    Math.abs(firstLength - secondLength) > scale * 1e-6 ||
    Math.abs(dot) > firstLength * secondLength * 1e-6
  ) {
    return undefined;
  }
  return parentWorld[0] * parentWorld[3] - parentWorld[1] * parentWorld[2] < 0 ? -1 : 1;
}

export function nodesInsideStageRect(
  graph: ResolvedPresentationGraph,
  surface: { readonly width: number; readonly height: number },
  start: StagePoint,
  end: StagePoint
): readonly string[] {
  const minimumX = Math.min(start[0], end[0]);
  const maximumX = Math.max(start[0], end[0]);
  const minimumY = Math.min(start[1], end[1]);
  const maximumY = Math.max(start[1], end[1]);
  const parents = parentMap(graph);
  return Object.values(graph.nodes)
    .filter(
      (node) =>
        node.primitive !== STANDARD_PRESENTATION_PRIMITIVES.group &&
        nodeIsEffectivelyVisible(graph, node.presentationId, parents)
    )
    .filter((node) => {
      const polygon = selectionPolygon(graph, node.presentationId, surface);
      if (polygon === undefined) return false;
      const xs = polygon.map((item) => item[0]);
      const ys = polygon.map((item) => item[1]);
      return !(
        Math.max(...xs) < minimumX ||
        Math.min(...xs) > maximumX ||
        Math.max(...ys) < minimumY ||
        Math.min(...ys) > maximumY
      );
    })
    .map((node) => node.presentationId);
}

export function nodeIsAncestor(
  document: StandardCompositionDocument,
  ancestorId: string,
  candidateId: string
): boolean {
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visited.has(nodeId)) return false;
    visited.add(nodeId);
    const node = document.data.nodes[nodeId];
    if (node === undefined) return false;
    return node.children.some((childId) => childId === candidateId || visit(childId));
  };
  return visit(ancestorId);
}

export function updateNodeSelection(
  document: StandardCompositionDocument,
  current: readonly string[],
  nodeId: string | undefined,
  mode: "replace" | "toggle" | "add" = "replace"
): readonly string[] {
  const existing = current.filter(
    (id, index) => document.data.nodes[id] !== undefined && current.indexOf(id) === index
  );
  if (nodeId === undefined || document.data.nodes[nodeId] === undefined) {
    return mode === "replace" ? [] : existing;
  }
  if (mode === "replace") return [nodeId];
  if (mode === "toggle" && existing.includes(nodeId)) {
    return existing.filter((id) => id !== nodeId);
  }
  const withoutRelated = existing.filter(
    (id) => !nodeIsAncestor(document, id, nodeId) && !nodeIsAncestor(document, nodeId, id)
  );
  return [...withoutRelated, nodeId];
}
