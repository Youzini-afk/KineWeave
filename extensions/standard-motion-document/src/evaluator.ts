import type { DocumentEvaluator } from "@kineweave/evaluation-engine";
import {
  PRESENTATION_GRAPH_VERSION,
  STANDARD_PRESENTATION_PRIMITIVES,
  cloneJson,
  compareRational,
  createProjectResourceUri,
  divideRational,
  hasErrorDiagnostics,
  parseRational,
  rationalToNumberLossy,
  subtractRational,
  type Diagnostic,
  type EvaluationRequest,
  type JsonObject,
  type JsonValue,
  type PresentationNode,
  type ResolvedPresentationGraph
} from "@kineweave/protocol";
import {
  STANDARD_COMPOSITION_SCHEMA_VERSION,
  STANDARD_COMPOSITION_TYPE,
  STANDARD_KEYFRAME_EASINGS,
  STANDARD_NODE_TYPES,
  STANDARD_SIGNAL_TYPES,
  STANDARD_VALUE_TYPES,
  type Keyframe,
  type MotionNode,
  type PropertyBinding,
  type PropertyTrack,
  type StandardCompositionDocument
} from "./model.js";
import { validateStandardComposition } from "./validation.js";
import {
  standardPropertyValueIssue,
  standardValueIssue
} from "./value-semantics.js";

type ValueResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false };

function error(
  code: string,
  message: string,
  documentId: string,
  jsonPointer?: string
): Diagnostic {
  return {
    severity: "error",
    code,
    message,
    documentId,
    ...(jsonPointer === undefined ? {} : { jsonPointer }),
    source: "@kineweave/standard-motion-document"
  };
}

function success(value: JsonValue): ValueResult {
  return { ok: true, value: cloneJson(value) };
}

function vector2(value: JsonValue): number[] | undefined {
  return Array.isArray(value) &&
    value.length === 2 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
    ? (value as number[])
    : undefined;
}

function parseHexColor(
  value: JsonValue
): { readonly channels: number[]; readonly alpha: boolean } | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value);
  if (match === null) return undefined;
  const hex = match[1]!;
  const channels = [0, 2, 4].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16)
  );
  channels.push(hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255);
  return { channels, alpha: hex.length === 8 };
}

function cubicBezierCoordinate(t: number, first: number, second: number): number {
  const inverse = 1 - t;
  return (
    3 * inverse * inverse * t * first +
    3 * inverse * t * t * second +
    t * t * t
  );
}

function cubicBezierProgress(
  progress: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    if (cubicBezierCoordinate(midpoint, x1, x2) < progress) lower = midpoint;
    else upper = midpoint;
  }
  return cubicBezierCoordinate((lower + upper) / 2, y1, y2);
}

function easedProgress(
  easing: Keyframe["easing"],
  progress: number,
  track: PropertyTrack,
  documentId: string,
  diagnostics: Diagnostic[]
): number | undefined {
  if (easing?.kind === STANDARD_KEYFRAME_EASINGS.hold) return undefined;
  if (easing?.kind === STANDARD_KEYFRAME_EASINGS.linear) return progress;
  if (easing?.kind === STANDARD_KEYFRAME_EASINGS.cubicBezier) {
    const { x1, y1, x2, y2 } = easing;
    if (
      typeof x1 === "number" &&
      Number.isFinite(x1) &&
      x1 >= 0 &&
      x1 <= 1 &&
      typeof y1 === "number" &&
      Number.isFinite(y1) &&
      typeof x2 === "number" &&
      Number.isFinite(x2) &&
      x2 >= 0 &&
      x2 <= 1 &&
      typeof y2 === "number" &&
      Number.isFinite(y2)
    ) {
      return cubicBezierProgress(progress, x1, y1, x2, y2);
    }
  }
  diagnostics.push(
    error(
      "standard-motion.evaluation.easing-unsupported",
      `Track ${track.trackId} uses invalid or unsupported easing ${String(easing?.kind)}`,
      documentId
    )
  );
  return Number.NaN;
}

function interpolateValue(
  track: PropertyTrack,
  left: JsonValue,
  right: JsonValue,
  progress: number,
  easing: Keyframe["easing"],
  documentId: string,
  diagnostics: Diagnostic[]
): ValueResult {
  const adjustedProgress = easedProgress(
    easing,
    progress,
    track,
    documentId,
    diagnostics
  );
  if (adjustedProgress === undefined) return success(left);
  if (!Number.isFinite(adjustedProgress)) return { ok: false };

  if (
    track.valueType === STANDARD_VALUE_TYPES.number &&
    typeof left === "number" &&
    typeof right === "number"
  ) {
    return success(left + (right - left) * adjustedProgress);
  }
  if (track.valueType === STANDARD_VALUE_TYPES.vector2) {
    const leftVector = vector2(left);
    const rightVector = vector2(right);
    if (leftVector !== undefined && rightVector !== undefined) {
      return success([
        leftVector[0]! +
          (rightVector[0]! - leftVector[0]!) * adjustedProgress,
        leftVector[1]! +
          (rightVector[1]! - leftVector[1]!) * adjustedProgress
      ]);
    }
  }
  if (track.valueType === STANDARD_VALUE_TYPES.color) {
    const leftColor = parseHexColor(left);
    const rightColor = parseHexColor(right);
    if (leftColor !== undefined && rightColor !== undefined) {
      const channels = leftColor.channels.map((channel, index) =>
        Math.round(
          channel +
            (rightColor.channels[index]! - channel) * adjustedProgress
        )
      );
      const includeAlpha = leftColor.alpha || rightColor.alpha;
      return success(
        `#${channels
          .slice(0, includeAlpha ? 4 : 3)
          .map((channel) => channel.toString(16).padStart(2, "0"))
          .join("")}`
      );
    }
  }

  diagnostics.push(
    error(
      "standard-motion.evaluation.interpolation-unsupported",
      `Track ${track.trackId} cannot interpolate ${track.valueType}`,
      documentId,
      `/data/tracks/${track.trackId}`
    )
  );
  return { ok: false };
}

function defaultEasing(track: PropertyTrack): string {
  return track.valueType === STANDARD_VALUE_TYPES.number ||
    track.valueType === STANDARD_VALUE_TYPES.vector2 ||
    track.valueType === STANDARD_VALUE_TYPES.color
    ? STANDARD_KEYFRAME_EASINGS.linear
    : STANDARD_KEYFRAME_EASINGS.hold;
}

function sampleTrack(
  track: PropertyTrack,
  request: EvaluationRequest,
  documentId: string,
  diagnostics: Diagnostic[]
): ValueResult {
  const keyframes = Object.values(track.keyframes).sort((left, right) => {
    const order = compareRational(left.time.value, right.time.value);
    return order === 0
      ? left.keyframeId.localeCompare(right.keyframeId)
      : order;
  });
  if (keyframes.length === 0) {
    diagnostics.push(
      error(
        "standard-motion.evaluation.track-empty",
        `Track ${track.trackId} has no keyframes`,
        documentId,
        `/data/tracks/${track.trackId}/keyframes`
      )
    );
    return { ok: false };
  }
  const domain = keyframes[0]!.time.domain;
  if (request.time.domain !== domain) {
    diagnostics.push(
      error(
        "standard-motion.evaluation.time-domain-mapping-required",
        `Track ${track.trackId} uses ${domain}, request uses ${request.time.domain}`,
        documentId,
        `/data/tracks/${track.trackId}`
      )
    );
    return { ok: false };
  }

  const requestedTime = parseRational(request.time.value);
  if (compareRational(requestedTime, keyframes[0]!.time.value) <= 0) {
    return success(keyframes[0]!.value);
  }
  for (let index = 1; index < keyframes.length; index += 1) {
    const right = keyframes[index]!;
    const comparison = compareRational(requestedTime, right.time.value);
    if (comparison > 0) continue;
    if (comparison === 0) return success(right.value);
    const left = keyframes[index - 1]!;
    const elapsed = subtractRational(requestedTime, left.time.value);
    const duration = subtractRational(right.time.value, left.time.value);
    const progress = rationalToNumberLossy(divideRational(elapsed, duration));
    return interpolateValue(
      track,
      left.value,
      right.value,
      progress,
      left.easing ?? { kind: defaultEasing(track) },
      documentId,
      diagnostics
    );
  }
  return success(keyframes.at(-1)!.value);
}

function resolveBinding(
  binding: PropertyBinding,
  document: StandardCompositionDocument,
  request: EvaluationRequest,
  diagnostics: Diagnostic[]
): ValueResult {
  if (binding.kind === "constant") {
    if ("value" in binding) return success(binding.value);
    diagnostics.push(
      error(
        "standard-motion.evaluation.constant-value-missing",
        "Constant binding requires a value",
        document.documentId
      )
    );
    return { ok: false };
  }
  if (binding.kind === "track") {
    const trackId = binding.trackId;
    const track =
      typeof trackId === "string" ? document.data.tracks[trackId] : undefined;
    if (track !== undefined) {
      return sampleTrack(track, request, document.documentId, diagnostics);
    }
  }
  if (binding.kind === "signal") {
    const signalId = binding.signalId;
    const signal =
      typeof signalId === "string" ? document.data.signals[signalId] : undefined;
    if (signal?.signalType === STANDARD_SIGNAL_TYPES.external) {
      const key = signal.data.key;
      if (typeof key === "string") {
        const externalValue = request.externalSignals[key];
        if (externalValue !== undefined) {
          const issue = standardValueIssue(signal.valueType, externalValue);
          if (issue === undefined) return success(externalValue);
          diagnostics.push(
            error(
              "standard-motion.evaluation.external-signal-value-invalid",
              `External signal ${key} value ${issue}`,
              document.documentId,
              `/data/signals/${signal.signalId}`
            )
          );
          return { ok: false };
        }
        const defaultValue = signal.data.defaultValue;
        if (defaultValue !== undefined) {
          const issue = standardValueIssue(signal.valueType, defaultValue);
          if (issue === undefined) return success(defaultValue);
          diagnostics.push(
            error(
              "standard-motion.evaluation.external-signal-default-invalid",
              `External signal ${key} default value ${issue}`,
              document.documentId,
              `/data/signals/${signal.signalId}/data/defaultValue`
            )
          );
          return { ok: false };
        }
        diagnostics.push(
          error(
            "standard-motion.evaluation.external-signal-missing",
            `External signal ${key} has no value or default`,
            document.documentId,
            `/data/signals/${signal.signalId}`
          )
        );
        return { ok: false };
      }
    }
    if (signal !== undefined) {
      diagnostics.push(
        error(
          "standard-motion.evaluation.signal-unsupported",
          `Signal ${signal.signalId} uses unsupported type ${signal.signalType}`,
          document.documentId,
          `/data/signals/${signal.signalId}`
        )
      );
      return { ok: false };
    }
  }
  diagnostics.push(
    error(
      "standard-motion.evaluation.binding-unresolved",
      `Cannot resolve property binding kind ${binding.kind}`,
      document.documentId
    )
  );
  return { ok: false };
}

function property(
  node: MotionNode,
  name: string,
  fallback: JsonValue,
  document: StandardCompositionDocument,
  request: EvaluationRequest,
  diagnostics: Diagnostic[]
): JsonValue {
  const binding = node.properties[name];
  if (binding === undefined) return cloneJson(fallback);
  const resolved = resolveBinding(binding, document, request, diagnostics);
  if (!resolved.ok) return cloneJson(fallback);
  const issue = standardPropertyValueIssue(node.nodeType, name, resolved.value);
  if (issue === undefined) return resolved.value;
  diagnostics.push(
    error(
      "standard-motion.evaluation.property-value-invalid",
      `Property ${node.nodeId}.${name} ${issue}`,
      document.documentId,
      `/data/nodes/${node.nodeId}/properties/${name}`
    )
  );
  return cloneJson(fallback);
}

function evaluateComposition(
  document: StandardCompositionDocument,
  request: EvaluationRequest
): { readonly graph: ResolvedPresentationGraph; readonly diagnostics: Diagnostic[] } {
  const diagnostics = [...validateStandardComposition(document)];
  if (hasErrorDiagnostics(diagnostics)) {
    return {
      graph: {
        presentationGraphVersion: PRESENTATION_GRAPH_VERSION,
        documentId: document.documentId,
        time: request.time,
        viewport: request.viewport,
        colorSpace: request.colorSpace,
        background: null,
        rootNodeIds: [],
        nodes: {},
        requiredFeatures: [request.colorSpace],
        metadata: { compositionValidationFailed: true }
      },
      diagnostics
    };
  }
  const nodes: Record<string, PresentationNode> = {};
  const requiredFeatures = new Set<string>([request.colorSpace]);

  const duration = document.data.duration;
  if (request.time.domain !== duration.domain) {
    diagnostics.push(
      error(
        "standard-motion.evaluation.duration-domain-mismatch",
        `Composition duration uses ${duration.domain}, request uses ${request.time.domain}`,
        document.documentId,
        "/data/duration"
      )
    );
  } else if (
    compareRational(request.time.value, { numerator: "0", denominator: "1" }) < 0 ||
    compareRational(request.time.value, duration.value) > 0
  ) {
    diagnostics.push(
      error(
        "standard-motion.evaluation.time-out-of-range",
        "Evaluation time is outside the composition duration",
        document.documentId
      )
    );
  }
  if (request.colorSpace !== document.data.canvas.colorSpace) {
    diagnostics.push(
      error(
        "standard-motion.evaluation.color-conversion-required",
        `Composition uses ${document.data.canvas.colorSpace}, request requires ${request.colorSpace}`,
        document.documentId,
        "/data/canvas/colorSpace"
      )
    );
  }

  const evaluatingNodes = new Set<string>();
  const evaluateNode = (nodeId: string): string | undefined => {
    const node = document.data.nodes[nodeId];
    if (node === undefined || !node.enabled) return undefined;
    if (evaluatingNodes.has(nodeId)) {
      diagnostics.push(
        error(
          "standard-motion.evaluation.hierarchy-cycle",
          `Cannot evaluate hierarchy cycle at ${nodeId}`,
          document.documentId,
          `/data/nodes/${nodeId}/children`
        )
      );
      return undefined;
    }
    evaluatingNodes.add(nodeId);
    const children = node.children
      .map((childId) => evaluateNode(childId))
      .filter((childId): childId is string => childId !== undefined);
    const position = vector2(
      property(node, "position", [0, 0], document, request, diagnostics)
    );
    const scale = vector2(
      property(node, "scale", [1, 1], document, request, diagnostics)
    );
    const anchor = vector2(
      property(node, "anchor", [0, 0], document, request, diagnostics)
    );
    const rotation = property(
      node,
      "rotation",
      0,
      document,
      request,
      diagnostics
    );
    const opacity = property(
      node,
      "opacity",
      1,
      document,
      request,
      diagnostics
    );
    const visible = property(
      node,
      "visible",
      true,
      document,
      request,
      diagnostics
    );
    if (position === undefined || scale === undefined || anchor === undefined) {
      diagnostics.push(
        error(
          "standard-motion.evaluation.transform-type-invalid",
          `Node ${nodeId} requires vector2 position, scale and anchor values`,
          document.documentId,
          `/data/nodes/${nodeId}/properties`
        )
      );
    }
    if (typeof rotation !== "number" || !Number.isFinite(rotation)) {
      diagnostics.push(
        error(
          "standard-motion.evaluation.rotation-type-invalid",
          `Node ${nodeId} rotation must be a finite number`,
          document.documentId,
          `/data/nodes/${nodeId}/properties/rotation`
        )
      );
    }
    if (
      typeof opacity !== "number" ||
      !Number.isFinite(opacity) ||
      opacity < 0 ||
      opacity > 1
    ) {
      diagnostics.push(
        error(
          "standard-motion.evaluation.opacity-type-invalid",
          `Node ${nodeId} opacity must be between 0 and 1`,
          document.documentId,
          `/data/nodes/${nodeId}/properties/opacity`
        )
      );
    }
    if (typeof visible !== "boolean") {
      diagnostics.push(
        error(
          "standard-motion.evaluation.visibility-type-invalid",
          `Node ${nodeId} visible must be boolean`,
          document.documentId,
          `/data/nodes/${nodeId}/properties/visible`
        )
      );
    }

    let primitive: string;
    let data: JsonObject;
    const shapeStyle = (): JsonObject => {
      const fill = property(
        node,
        "fill",
        "#00000000",
        document,
        request,
        diagnostics
      );
      const stroke = property(
        node,
        "stroke",
        "#00000000",
        document,
        request,
        diagnostics
      );
      const strokeWidth = property(
        node,
        "strokeWidth",
        0,
        document,
        request,
        diagnostics
      );
      return {
        fill: typeof fill === "string" ? fill : "#00000000",
        stroke: typeof stroke === "string" ? stroke : "#00000000",
        strokeWidth:
          typeof strokeWidth === "number" &&
          Number.isFinite(strokeWidth) &&
          strokeWidth >= 0
            ? strokeWidth
            : 0
      };
    };
    if (node.nodeType === STANDARD_NODE_TYPES.group) {
      primitive = STANDARD_PRESENTATION_PRIMITIVES.group;
      data = cloneJson(node.data);
    } else if (node.nodeType === STANDARD_NODE_TYPES.text) {
      primitive = STANDARD_PRESENTATION_PRIMITIVES.text;
      const content = property(
        node,
        "content",
        "",
        document,
        request,
        diagnostics
      );
      const fontSize = property(
        node,
        "fontSize",
        16,
        document,
        request,
        diagnostics
      );
      const fill = property(
        node,
        "fill",
        "#000000",
        document,
        request,
        diagnostics
      );
      if (typeof content !== "string") {
        diagnostics.push(
          error(
            "standard-motion.evaluation.text-content-invalid",
            `Text node ${nodeId} content must resolve to a string`,
            document.documentId
          )
        );
      }
      if (typeof fontSize !== "number" || !Number.isFinite(fontSize) || fontSize <= 0) {
        diagnostics.push(
          error(
            "standard-motion.evaluation.text-font-size-invalid",
            `Text node ${nodeId} fontSize must resolve to a positive number`,
            document.documentId
          )
        );
      }
      if (typeof fill !== "string") {
        diagnostics.push(
          error(
            "standard-motion.evaluation.text-fill-invalid",
            `Text node ${nodeId} fill must resolve to a string`,
            document.documentId
          )
        );
      }
      data = {
        text: typeof content === "string" ? content : "",
        fontSize:
          typeof fontSize === "number" && Number.isFinite(fontSize)
            ? fontSize
            : 16,
        fill: typeof fill === "string" ? fill : "#000000"
      };
    } else if (node.nodeType === STANDARD_NODE_TYPES.rectangle) {
      primitive = STANDARD_PRESENTATION_PRIMITIVES.rectangle;
      const size = vector2(
        property(node, "size", [100, 100], document, request, diagnostics)
      );
      const cornerRadius = property(
        node,
        "cornerRadius",
        0,
        document,
        request,
        diagnostics
      );
      const width = size?.[0];
      const height = size?.[1];
      data = {
        width:
          typeof width === "number" && Number.isFinite(width) && width > 0
            ? width
            : 100,
        height:
          typeof height === "number" && Number.isFinite(height) && height > 0
            ? height
            : 100,
        cornerRadius:
          typeof cornerRadius === "number" &&
          Number.isFinite(cornerRadius) &&
          cornerRadius >= 0
            ? cornerRadius
            : 0,
        ...shapeStyle()
      };
    } else if (node.nodeType === STANDARD_NODE_TYPES.ellipse) {
      primitive = STANDARD_PRESENTATION_PRIMITIVES.ellipse;
      const size = vector2(
        property(node, "size", [100, 100], document, request, diagnostics)
      );
      const width = size?.[0];
      const height = size?.[1];
      data = {
        radiusX:
          typeof width === "number" && Number.isFinite(width) && width > 0
            ? width / 2
            : 50,
        radiusY:
          typeof height === "number" && Number.isFinite(height) && height > 0
            ? height / 2
            : 50,
        ...shapeStyle()
      };
    } else if (node.nodeType === STANDARD_NODE_TYPES.path) {
      primitive = STANDARD_PRESENTATION_PRIMITIVES.path;
      const path = property(
        node,
        "path",
        "M 0 0",
        document,
        request,
        diagnostics
      );
      data = {
        path:
          typeof path === "string" && path.trim().length > 0 ? path : "M 0 0",
        ...shapeStyle()
      };
    } else {
      primitive = STANDARD_PRESENTATION_PRIMITIVES.custom;
      const resolvedProperties: JsonObject = {};
      for (const [name, binding] of Object.entries(node.properties)) {
        const resolved = resolveBinding(binding, document, request, diagnostics);
        if (resolved.ok) resolvedProperties[name] = resolved.value;
      }
      data = {
        packetType: node.nodeType,
        schemaVersion: node.schemaVersion,
        nodeData: cloneJson(node.data),
        properties: resolvedProperties
      };
      requiredFeatures.add(node.nodeType);
    }
    requiredFeatures.add(primitive);
    nodes[nodeId] = {
      presentationId: nodeId,
      primitive,
      children,
      visible: typeof visible === "boolean" ? visible : true,
      opacity:
        typeof opacity === "number" &&
        Number.isFinite(opacity) &&
        opacity >= 0 &&
        opacity <= 1
          ? opacity
          : 1,
      transform: {
        translation: position ?? [0, 0],
        scale: scale ?? [1, 1],
        rotation:
          typeof rotation === "number" && Number.isFinite(rotation)
            ? rotation
            : 0,
        anchor: anchor ?? [0, 0]
      },
      sourceResourceUri: createProjectResourceUri("document", document.documentId, [
        "node",
        nodeId
      ]),
      data
    };
    evaluatingNodes.delete(nodeId);
    return nodeId;
  };

  const rootNodeIds = document.data.rootNodeIds
    .map((nodeId) => evaluateNode(nodeId))
    .filter((nodeId): nodeId is string => nodeId !== undefined);
  const backgroundBinding = document.data.canvas.background;
  const background =
    backgroundBinding === undefined
      ? null
      : resolveBinding(backgroundBinding, document, request, diagnostics);

  return {
    graph: {
      presentationGraphVersion: PRESENTATION_GRAPH_VERSION,
      documentId: document.documentId,
      time: request.time,
      viewport: request.viewport,
      colorSpace: request.colorSpace,
      background:
        background !== null &&
        background.ok &&
        typeof background.value === "string"
          ? background.value
          : null,
      rootNodeIds,
      nodes,
      requiredFeatures: [...requiredFeatures].sort(),
      metadata: {
        compositionName: document.data.name,
        compositionCanvas: {
          width: document.data.canvas.width,
          height: document.data.canvas.height,
          pixelAspectRatio: cloneJson(document.data.canvas.pixelAspectRatio)
        }
      }
    },
    diagnostics
  };
}

export const standardMotionDocumentEvaluator: DocumentEvaluator = {
  documentType: STANDARD_COMPOSITION_TYPE,
  schemaVersion: STANDARD_COMPOSITION_SCHEMA_VERSION,
  presentationGraphVersions: [PRESENTATION_GRAPH_VERSION],
  evaluate(document, request) {
    return evaluateComposition(document as StandardCompositionDocument, request);
  }
};
