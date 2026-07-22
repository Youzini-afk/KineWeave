import {
  assertStableId,
  compareRational,
  parseRational,
  rational,
  type Diagnostic,
  type JsonObject,
  type JsonValue,
  type ProjectDocumentEnvelope
} from "@kineweave/protocol";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import compositionSchema from "./schemas/composition-v2.schema.json" with { type: "json" };
import {
  STANDARD_KEYFRAME_EASINGS,
  STANDARD_NODE_SCHEMA_VERSION,
  STANDARD_NODE_TYPES,
  STANDARD_SIGNAL_SCHEMA_VERSION,
  STANDARD_SIGNAL_TYPES,
  type MotionNode,
  type PropertyBinding,
  type StandardCompositionDocument
} from "./model.js";
import {
  STANDARD_CANVAS_BACKGROUND_VALUE_TYPE,
  expectedStandardPropertyValueType,
  isStandardInterpolatedValueType,
  standardPropertyValueIssue,
  standardValueIssue
} from "./value-semantics.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(compositionSchema);
const STANDARD_NODE_TYPE_SET = new Set<string>(Object.values(STANDARD_NODE_TYPES));
const LEAF_NODE_TYPE_SET = new Set<string>([
  STANDARD_NODE_TYPES.text,
  STANDARD_NODE_TYPES.rectangle,
  STANDARD_NODE_TYPES.ellipse,
  STANDARD_NODE_TYPES.path
]);

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

function schemaDiagnostics(
  documentId: string,
  errors: readonly ErrorObject[] | null | undefined
): readonly Diagnostic[] {
  return (errors ?? []).map((item) =>
    error(
      `standard-motion.schema.${item.keyword}`,
      item.message ?? `Schema keyword ${item.keyword} failed`,
      documentId,
      item.instancePath || "/"
    )
  );
}

function validateBinding(
  binding: PropertyBinding,
  document: StandardCompositionDocument,
  label: string,
  jsonPointer: string,
  expectation: {
    readonly valueType?: string;
    readonly validateValue?: (value: JsonValue) => string | undefined;
    readonly trackTarget?: {
      readonly nodeId: string;
      readonly property: string;
    };
    readonly allowTrack?: boolean;
  },
  diagnostics: Diagnostic[]
): void {
  if (binding.kind === "constant") {
    if (!("value" in binding)) {
      diagnostics.push(
        error(
          "standard-motion.binding.constant-value-missing",
          `${label} constant binding requires a value`,
          document.documentId,
          jsonPointer
        )
      );
      return;
    }
    const issue = expectation.validateValue?.(binding.value);
    if (issue !== undefined) {
      diagnostics.push(
        error(
          "standard-motion.binding.constant-value-invalid",
          `${label} ${issue}`,
          document.documentId,
          `${jsonPointer}/value`
        )
      );
    }
    return;
  }
  if (binding.kind === "track") {
    if (expectation.allowTrack === false) {
      diagnostics.push(
        error(
          "standard-motion.binding.track-unsupported",
          `${label} does not currently support track bindings`,
          document.documentId,
          jsonPointer
        )
      );
      return;
    }
    const trackId = binding.trackId;
    const track =
      typeof trackId === "string" ? document.data.tracks[trackId] : undefined;
    if (track === undefined) {
      diagnostics.push(
        error(
          "standard-motion.binding.track-missing",
          `${label} references missing track ${String(trackId)}`,
          document.documentId,
          jsonPointer
        )
      );
      return;
    }
    if (
      expectation.trackTarget !== undefined &&
      (track.target.nodeId !== expectation.trackTarget.nodeId ||
        track.target.property !== expectation.trackTarget.property)
    ) {
      diagnostics.push(
        error(
          "standard-motion.binding.track-target-mismatch",
          `Track ${trackId} targets ${track.target.nodeId}.${track.target.property}, not ${expectation.trackTarget.nodeId}.${expectation.trackTarget.property}`,
          document.documentId,
          jsonPointer
        )
      );
    }
    if (
      expectation.valueType !== undefined &&
      track.valueType !== expectation.valueType
    ) {
      diagnostics.push(
        error(
          "standard-motion.binding.value-type-mismatch",
          `${label} requires ${expectation.valueType}, but track ${trackId} provides ${track.valueType}`,
          document.documentId,
          jsonPointer
        )
      );
    }
    return;
  }
  if (binding.kind === "signal") {
    const signalId = binding.signalId;
    const signal =
      typeof signalId === "string" ? document.data.signals[signalId] : undefined;
    if (signal === undefined) {
      diagnostics.push(
        error(
          "standard-motion.binding.signal-missing",
          `${label} references missing signal ${String(signalId)}`,
          document.documentId,
          jsonPointer
        )
      );
      return;
    }
    if (
      expectation.valueType !== undefined &&
      signal.valueType !== expectation.valueType
    ) {
      diagnostics.push(
        error(
          "standard-motion.binding.value-type-mismatch",
          `${label} requires ${expectation.valueType}, but signal ${signalId} provides ${signal.valueType}`,
          document.documentId,
          jsonPointer
        )
      );
    }
    return;
  }
  diagnostics.push(
    error(
      "standard-motion.binding.kind-unsupported",
      `${label} uses unsupported binding kind ${binding.kind}`,
      document.documentId,
      jsonPointer
    )
  );
}

export function validateStandardComposition(
  rawDocument: ProjectDocumentEnvelope<JsonObject>
): readonly Diagnostic[] {
  validateSchema(rawDocument);
  const diagnostics = schemaDiagnostics(
    rawDocument.documentId,
    validateSchema.errors
  );
  if (diagnostics.length > 0) return diagnostics;

  const document = rawDocument as StandardCompositionDocument;
  const result: Diagnostic[] = [];

  if (document.data.canvas.background !== undefined) {
    validateBinding(
      document.data.canvas.background,
      document,
      "Canvas background",
      "/data/canvas/background",
      {
        valueType: STANDARD_CANVAS_BACKGROUND_VALUE_TYPE,
        validateValue: (value) =>
          standardValueIssue(STANDARD_CANVAS_BACKGROUND_VALUE_TYPE, value),
        allowTrack: false
      },
      result
    );
  }

  try {
    const duration = parseRational(document.data.duration.value);
    if (compareRational(duration, rational(0)) <= 0) {
      result.push(
        error(
          "standard-motion.duration.non-positive",
          "Composition duration must be positive",
          document.documentId,
          "/data/duration"
        )
      );
    }
  } catch (caught) {
    result.push(
      error(
        "standard-motion.duration.invalid",
        caught instanceof Error ? caught.message : String(caught),
        document.documentId,
        "/data/duration"
      )
    );
  }

  const owners = new Map<string, string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(nodeId: string, owner: string): void {
    const node = document.data.nodes[nodeId];
    if (node === undefined) {
      result.push(
        error(
          "standard-motion.hierarchy.node-missing",
          `Hierarchy references missing node ${nodeId}`,
          document.documentId
        )
      );
      return;
    }
    if (visiting.has(nodeId)) {
      result.push(
        error(
          "standard-motion.hierarchy.cycle",
          `Hierarchy cycle detected at ${nodeId}`,
          document.documentId
        )
      );
      return;
    }
    const existingOwner = owners.get(nodeId);
    if (existingOwner !== undefined && existingOwner !== owner) {
      result.push(
        error(
          "standard-motion.hierarchy.multiple-parents",
          `Node ${nodeId} belongs to both ${existingOwner} and ${owner}`,
          document.documentId
        )
      );
      return;
    }
    owners.set(nodeId, owner);
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const childId of node.children) visit(childId, nodeId);
    visiting.delete(nodeId);
    visited.add(nodeId);
  }

  for (const rootNodeId of document.data.rootNodeIds) {
    visit(rootNodeId, "$root");
  }

  for (const [nodeId, node] of Object.entries(document.data.nodes)) {
    if (node.nodeId !== nodeId) {
      result.push(
        error(
          "standard-motion.node.id-mismatch",
          `Node map key ${nodeId} does not match nodeId ${node.nodeId}`,
          document.documentId,
          `/data/nodes/${nodeId}/nodeId`
        )
      );
    }
    if (!owners.has(nodeId)) {
      result.push(
        error(
          "standard-motion.hierarchy.orphan",
          `Node ${nodeId} is not reachable from rootNodeIds`,
          document.documentId,
          `/data/nodes/${nodeId}`
        )
      );
    }
    if (
      STANDARD_NODE_TYPE_SET.has(node.nodeType) &&
      node.schemaVersion !== STANDARD_NODE_SCHEMA_VERSION
    ) {
      result.push(
        error(
          "standard-motion.node.schema-version-unsupported",
          `Standard node ${nodeId} uses unsupported schema version ${node.schemaVersion}`,
          document.documentId,
          `/data/nodes/${nodeId}/schemaVersion`
        )
      );
    }
    for (const [property, binding] of Object.entries(node.properties)) {
      const expectedValueType = expectedStandardPropertyValueType(
        node.nodeType,
        property
      );
      validateBinding(
        binding,
        document,
        `Property ${nodeId}.${property}`,
        `/data/nodes/${nodeId}/properties/${property}`,
        {
          ...(expectedValueType === undefined ? {} : { valueType: expectedValueType }),
          validateValue: (value) =>
            standardPropertyValueIssue(node.nodeType, property, value),
          trackTarget: { nodeId, property }
        },
        result
      );
    }
    if (LEAF_NODE_TYPE_SET.has(node.nodeType)) {
      if (node.children.length > 0) {
        result.push(
          error(
            "standard-motion.leaf.children-unsupported",
            `Leaf node ${nodeId} cannot contain child nodes`,
            document.documentId,
            `/data/nodes/${nodeId}/children`
          )
        );
      }
    }
    const requiredProperty =
      node.nodeType === STANDARD_NODE_TYPES.text
        ? "content"
        : node.nodeType === STANDARD_NODE_TYPES.rectangle ||
            node.nodeType === STANDARD_NODE_TYPES.ellipse
          ? "size"
          : node.nodeType === STANDARD_NODE_TYPES.path
            ? "path"
            : undefined;
    if (
      requiredProperty !== undefined &&
      node.properties[requiredProperty] === undefined
    ) {
      result.push(
        error(
          "standard-motion.node.property-required",
          `${node.name} node ${nodeId} requires a ${requiredProperty} binding`,
          document.documentId,
          `/data/nodes/${nodeId}/properties/${requiredProperty}`
        )
      );
    }
    if (node.nodeType === STANDARD_NODE_TYPES.group) {
      for (const property of ["size", "path", "fill", "stroke", "strokeWidth"]) {
        if (node.properties[property] !== undefined) {
          result.push(
            error(
              "standard-motion.group.property-unsupported",
              `Group node ${nodeId} cannot define shape property ${property}`,
              document.documentId,
              `/data/nodes/${nodeId}/properties/${property}`
            )
          );
        }
      }
    }
  }

  for (const [trackId, track] of Object.entries(document.data.tracks)) {
    if (track.trackId !== trackId) {
      result.push(
        error(
          "standard-motion.track.id-mismatch",
          `Track map key ${trackId} does not match trackId ${track.trackId}`,
          document.documentId,
          `/data/tracks/${trackId}/trackId`
        )
      );
    }
    const targetNode = document.data.nodes[track.target.nodeId];
    if (targetNode === undefined) {
      result.push(
        error(
          "standard-motion.track.target-node-missing",
          `Track ${trackId} targets missing node ${track.target.nodeId}`,
          document.documentId,
          `/data/tracks/${trackId}/target/nodeId`
        )
      );
    } else {
      const targetBinding = targetNode.properties[track.target.property];
      if (
        targetBinding?.kind !== "track" ||
        targetBinding.trackId !== trackId
      ) {
        result.push(
          error(
            "standard-motion.track.target-unbound",
            `Track ${trackId} target ${track.target.nodeId}.${track.target.property} does not bind back to this track`,
            document.documentId,
            `/data/tracks/${trackId}/target`
          )
        );
      }
      const expectedValueType = expectedStandardPropertyValueType(
        targetNode.nodeType,
        track.target.property
      );
      if (
        expectedValueType !== undefined &&
        track.valueType !== expectedValueType
      ) {
        result.push(
          error(
            "standard-motion.track.value-type-mismatch",
            `Track ${trackId} provides ${track.valueType}, but ${track.target.nodeId}.${track.target.property} requires ${expectedValueType}`,
            document.documentId,
            `/data/tracks/${trackId}/valueType`
          )
        );
      }
    }
    let timeDomain: string | undefined;
    const keyframesByTime = new Map<string, string>();
    for (const [keyframeId, keyframe] of Object.entries(track.keyframes)) {
      if (keyframe.keyframeId !== keyframeId) {
        result.push(
          error(
            "standard-motion.keyframe.id-mismatch",
            `Keyframe map key ${keyframeId} does not match ${keyframe.keyframeId}`,
            document.documentId,
            `/data/tracks/${trackId}/keyframes/${keyframeId}/keyframeId`
          )
        );
      }
      timeDomain ??= keyframe.time.domain;
      if (keyframe.time.domain !== timeDomain) {
        result.push(
          error(
            "standard-motion.track.time-domain-mixed",
            `Track ${trackId} mixes time domains`,
            document.documentId,
            `/data/tracks/${trackId}/keyframes/${keyframeId}/time/domain`
          )
        );
      }
      if (keyframe.time.domain !== document.data.duration.domain) {
        result.push(
          error(
            "standard-motion.track.time-domain-mapping-required",
            `Track ${trackId} uses ${keyframe.time.domain}, but the composition uses ${document.data.duration.domain}`,
            document.documentId,
            `/data/tracks/${trackId}/keyframes/${keyframeId}/time/domain`
          )
        );
      }
      try {
        const time = parseRational(keyframe.time.value);
        if (compareRational(time, rational(0)) < 0) {
          result.push(
            error(
              "standard-motion.keyframe.time-negative",
              `Keyframe ${keyframeId} has negative time`,
              document.documentId,
              `/data/tracks/${trackId}/keyframes/${keyframeId}/time`
            )
          );
        }
        const timeKey = `${time.numerator}/${time.denominator}`;
        const duplicate = keyframesByTime.get(timeKey);
        if (duplicate !== undefined) {
          result.push(
            error(
              "standard-motion.keyframe.time-duplicate",
              `Keyframes ${duplicate} and ${keyframeId} have the same time`,
              document.documentId,
              `/data/tracks/${trackId}/keyframes/${keyframeId}/time`
            )
          );
        } else {
          keyframesByTime.set(timeKey, keyframeId);
        }
      } catch (caught) {
        result.push(
          error(
            "standard-motion.keyframe.time-invalid",
            caught instanceof Error ? caught.message : String(caught),
            document.documentId,
            `/data/tracks/${trackId}/keyframes/${keyframeId}/time`
          )
        );
      }
      const genericValueIssue = standardValueIssue(track.valueType, keyframe.value);
      const targetValueIssue =
        targetNode === undefined
          ? undefined
          : standardPropertyValueIssue(
              targetNode.nodeType,
              track.target.property,
              keyframe.value
            );
      const valueIssue = genericValueIssue ?? targetValueIssue;
      if (valueIssue !== undefined) {
        result.push(
          error(
            "standard-motion.keyframe.value-invalid",
            `Keyframe ${keyframeId} ${valueIssue}`,
            document.documentId,
            `/data/tracks/${trackId}/keyframes/${keyframeId}/value`
          )
        );
      }
      if (
        keyframe.easing !== undefined &&
        keyframe.easing.kind !== STANDARD_KEYFRAME_EASINGS.linear &&
        keyframe.easing.kind !== STANDARD_KEYFRAME_EASINGS.hold &&
        keyframe.easing.kind !== STANDARD_KEYFRAME_EASINGS.cubicBezier
      ) {
        result.push(
          error(
            "standard-motion.keyframe.easing-unsupported",
            `Keyframe ${keyframeId} uses unsupported easing ${keyframe.easing.kind}`,
            document.documentId,
            `/data/tracks/${trackId}/keyframes/${keyframeId}/easing/kind`
          )
        );
      }
      if (
        (keyframe.easing?.kind === STANDARD_KEYFRAME_EASINGS.linear ||
          keyframe.easing?.kind === STANDARD_KEYFRAME_EASINGS.cubicBezier) &&
        !isStandardInterpolatedValueType(track.valueType)
      ) {
        result.push(
          error(
            "standard-motion.keyframe.easing-value-type-invalid",
            `Track ${trackId} cannot interpolate ${track.valueType}`,
            document.documentId,
            `/data/tracks/${trackId}/keyframes/${keyframeId}/easing/kind`
          )
        );
      }
    }
  }

  for (const [signalId, signal] of Object.entries(document.data.signals)) {
    if (signal.signalId !== signalId) {
      result.push(
        error(
          "standard-motion.signal.id-mismatch",
          `Signal map key ${signalId} does not match signalId ${signal.signalId}`,
          document.documentId,
          `/data/signals/${signalId}/signalId`
        )
      );
    }
    if (signal.signalType === STANDARD_SIGNAL_TYPES.external) {
      if (signal.schemaVersion !== STANDARD_SIGNAL_SCHEMA_VERSION) {
        result.push(
          error(
            "standard-motion.signal.schema-version-unsupported",
            `External signal ${signalId} uses unsupported schema version ${signal.schemaVersion}`,
            document.documentId,
            `/data/signals/${signalId}/schemaVersion`
          )
        );
      }
      const key = signal.data.key;
      try {
        if (typeof key !== "string") throw new TypeError("Signal key is required");
        assertStableId(key, "external signal key");
      } catch (caught) {
        result.push(
          error(
            "standard-motion.signal.external-key-invalid",
            caught instanceof Error ? caught.message : String(caught),
            document.documentId,
            `/data/signals/${signalId}/data/key`
          )
        );
      }
      if (signal.data.defaultValue !== undefined) {
        const valueIssue = standardValueIssue(
          signal.valueType,
          signal.data.defaultValue
        );
        if (valueIssue !== undefined) {
          result.push(
            error(
              "standard-motion.signal.default-value-invalid",
              `Signal ${signalId} default value ${valueIssue}`,
              document.documentId,
              `/data/signals/${signalId}/data/defaultValue`
            )
          );
        }
      }
    } else {
      result.push(
        error(
          "standard-motion.signal.type-unsupported",
          `Signal ${signalId} uses unsupported type ${signal.signalType}`,
          document.documentId,
          `/data/signals/${signalId}/signalType`
        )
      );
    }
  }

  return result;
}

export function nodeIsDescendant(
  nodes: Readonly<Record<string, MotionNode>>,
  candidateId: string,
  ancestorId: string
): boolean {
  const visited = new Set<string>();
  const visit = (currentId: string): boolean => {
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    const current = nodes[currentId];
    if (current === undefined) return false;
    return current.children.some(
      (childId) => childId === candidateId || visit(childId)
    );
  };
  return visit(ancestorId);
}
