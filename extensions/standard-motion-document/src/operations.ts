import {
  cloneJson,
  compareRational,
  type JsonObject,
  type JsonValue,
  type Operation,
  parseRational,
  rational
} from "@kineweave/protocol";
import type { OperationHandler, OperationReadContext } from "@kineweave/transaction-engine";
import {
  type Keyframe,
  type MotionNode,
  type PropertyBinding,
  type PropertyTrack,
  type SerializedTimeValue,
  STANDARD_COMPOSITION_TYPE,
  type StandardCompositionDocument
} from "./model.js";
import { nodeIsDescendant } from "./validation.js";

export const STANDARD_MOTION_OPERATIONS = {
  insertNode: "org.kineweave.standard-motion/insert-node",
  removeNode: "org.kineweave.standard-motion/remove-node",
  moveNode: "org.kineweave.standard-motion/move-node",
  setNodeAttributes: "org.kineweave.standard-motion/set-node-attributes",
  setProperty: "org.kineweave.standard-motion/set-property",
  setDuration: "org.kineweave.standard-motion/set-duration",
  createTrack: "org.kineweave.standard-motion/create-track",
  removeTrack: "org.kineweave.standard-motion/remove-track",
  upsertKeyframe: "org.kineweave.standard-motion/upsert-keyframe",
  moveKeyframe: "org.kineweave.standard-motion/move-keyframe",
  deleteKeyframe: "org.kineweave.standard-motion/delete-keyframe",
  setKeyframeEasing: "org.kineweave.standard-motion/set-keyframe-easing"
} as const;

function payload(operation: Operation): JsonObject {
  if (
    operation.payload === null ||
    Array.isArray(operation.payload) ||
    typeof operation.payload !== "object"
  ) {
    throw new TypeError(`${operation.operationType} requires an object payload`);
  }
  return operation.payload;
}

function composition(
  context: OperationReadContext,
  documentId: string
): StandardCompositionDocument {
  const document = context.readDocument(documentId);
  if (document === undefined) throw new Error(`Document ${documentId} is missing`);
  if (document.documentType !== STANDARD_COMPOSITION_TYPE) {
    throw new TypeError(`${documentId} is not a Standard Motion Composition`);
  }
  return document as StandardCompositionDocument;
}

function insertionList(
  document: StandardCompositionDocument,
  parentNodeId: string | null
): string[] {
  if (parentNodeId === null) return document.data.rootNodeIds;
  const parent = document.data.nodes[parentNodeId];
  if (parent === undefined) throw new Error(`Parent node ${parentNodeId} is missing`);
  return parent.children;
}

function removeFromHierarchy(document: StandardCompositionDocument, nodeId: string): void {
  const rootIndex = document.data.rootNodeIds.indexOf(nodeId);
  if (rootIndex !== -1) {
    document.data.rootNodeIds.splice(rootIndex, 1);
    return;
  }
  for (const node of Object.values(document.data.nodes)) {
    const childIndex = node.children.indexOf(nodeId);
    if (childIndex !== -1) {
      node.children.splice(childIndex, 1);
      return;
    }
  }
  throw new Error(`Node ${nodeId} is not attached to the hierarchy`);
}

function subtreeIds(
  nodes: Readonly<Record<string, MotionNode>>,
  nodeId: string,
  result = new Set<string>()
): ReadonlySet<string> {
  if (result.has(nodeId)) return result;
  const node = nodes[nodeId];
  if (node === undefined) throw new Error(`Node ${nodeId} is missing`);
  result.add(nodeId);
  for (const childId of node.children) subtreeIds(nodes, childId, result);
  return result;
}

function replaceMutation(document: StandardCompositionDocument) {
  return {
    kind: "replace" as const,
    documentId: document.documentId,
    document
  };
}

function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function editableComposition(
  context: OperationReadContext,
  documentId: string
): StandardCompositionDocument {
  return cloneJson(
    composition(context, documentId) as unknown as JsonValue
  ) as unknown as StandardCompositionDocument;
}

function normalizedTime(value: JsonValue | undefined, label: string): SerializedTimeValue {
  const input = objectValue(value, label);
  if (typeof input.domain !== "string") {
    throw new TypeError(`${label}.domain must be a string`);
  }
  return {
    domain: input.domain,
    value: parseRational(input.value)
  } as SerializedTimeValue;
}

function assertTimeInComposition(
  document: StandardCompositionDocument,
  time: SerializedTimeValue,
  label: string
): void {
  if (time.domain !== document.data.duration.domain) {
    throw new TypeError(
      `${label} uses ${time.domain}, but the composition uses ${document.data.duration.domain}`
    );
  }
  const value = parseRational(time.value);
  if (compareRational(value, rational(0)) < 0) {
    throw new RangeError(`${label} cannot be negative`);
  }
  if (compareRational(value, parseRational(document.data.duration.value)) > 0) {
    throw new RangeError(`${label} cannot exceed the composition duration`);
  }
}

function normalizedKeyframe(value: JsonValue | undefined, label: string): Keyframe {
  const input = objectValue(value, label);
  const keyframeValue = input.value;
  if (typeof input.keyframeId !== "string" || keyframeValue === undefined) {
    throw new TypeError(`${label} requires keyframeId, time and value`);
  }
  return {
    ...cloneJson(input),
    keyframeId: input.keyframeId,
    time: normalizedTime(input.time, `${label}.time`),
    value: cloneJson(keyframeValue)
  } as Keyframe;
}

function normalizedTrack(value: JsonValue | undefined): PropertyTrack {
  const input = objectValue(value, "create-track track");
  const target = objectValue(input.target, "create-track track.target");
  const keyframes = objectValue(input.keyframes, "create-track track.keyframes");
  if (
    typeof input.trackId !== "string" ||
    typeof input.valueType !== "string" ||
    typeof target.nodeId !== "string" ||
    typeof target.property !== "string" ||
    target.property.length === 0
  ) {
    throw new TypeError("create-track track is invalid");
  }
  const normalizedKeyframes: Record<string, Keyframe> = {};
  for (const [keyframeId, rawKeyframe] of Object.entries(keyframes)) {
    const keyframe = normalizedKeyframe(rawKeyframe, `Keyframe ${keyframeId}`);
    if (keyframe.keyframeId !== keyframeId) {
      throw new TypeError(`Keyframe map key ${keyframeId} does not match ${keyframe.keyframeId}`);
    }
    normalizedKeyframes[keyframeId] = keyframe;
  }
  if (Object.keys(normalizedKeyframes).length === 0) {
    throw new TypeError("A property track requires at least one keyframe");
  }
  return {
    ...cloneJson(input),
    trackId: input.trackId,
    valueType: input.valueType,
    target: {
      ...cloneJson(target),
      nodeId: target.nodeId,
      property: target.property
    },
    keyframes: normalizedKeyframes
  } as PropertyTrack;
}

function propertyTrack(document: StandardCompositionDocument, trackId: string): PropertyTrack {
  const track = document.data.tracks[trackId];
  if (track === undefined) throw new Error(`Track ${trackId} is missing`);
  return track;
}

function assertUniqueKeyframeTime(
  track: PropertyTrack,
  keyframe: Keyframe,
  exceptKeyframeId?: string
): void {
  const candidate = parseRational(keyframe.time.value);
  for (const existing of Object.values(track.keyframes)) {
    if (existing.keyframeId === exceptKeyframeId) continue;
    if (
      existing.time.domain === keyframe.time.domain &&
      compareRational(parseRational(existing.time.value), candidate) === 0
    ) {
      throw new Error(
        `Keyframe ${keyframe.keyframeId} collides with ${existing.keyframeId} at the same time`
      );
    }
  }
}

export const insertNodeHandler: OperationHandler = {
  operationType: STANDARD_MOTION_OPERATIONS.insertNode,
  schemaVersion: 1,
  prepare(operation, context) {
    const input = payload(operation);
    const documentId = input.documentId;
    const parentNodeId = input.parentNodeId;
    const index = input.index;
    const node = input.node;
    if (
      typeof documentId !== "string" ||
      !(parentNodeId === null || typeof parentNodeId === "string") ||
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      node === null ||
      Array.isArray(node) ||
      typeof node !== "object"
    ) {
      throw new TypeError("insert-node payload is invalid");
    }
    const next = cloneJson(
      composition(context, documentId) as unknown as JsonValue
    ) as unknown as StandardCompositionDocument;
    const motionNode = node as MotionNode;
    if (next.data.nodes[motionNode.nodeId] !== undefined) {
      throw new Error(`Node ${motionNode.nodeId} already exists`);
    }
    const children = insertionList(next, parentNodeId);
    if (index < 0 || index > children.length) {
      throw new RangeError(`Insertion index ${index} is out of range`);
    }
    next.data.nodes[motionNode.nodeId] = cloneJson(node) as MotionNode;
    children.splice(index, 0, motionNode.nodeId);
    return { mutations: [replaceMutation(next)] };
  }
};

export const removeNodeHandler: OperationHandler = {
  operationType: STANDARD_MOTION_OPERATIONS.removeNode,
  schemaVersion: 1,
  prepare(operation, context) {
    const input = payload(operation);
    if (typeof input.documentId !== "string" || typeof input.nodeId !== "string") {
      throw new TypeError("remove-node requires documentId and nodeId");
    }
    const next = cloneJson(
      composition(context, input.documentId) as unknown as JsonValue
    ) as unknown as StandardCompositionDocument;
    removeFromHierarchy(next, input.nodeId);
    const removing = subtreeIds(next.data.nodes, input.nodeId);
    for (const nodeId of removing) delete next.data.nodes[nodeId];
    for (const [trackId, track] of Object.entries(next.data.tracks)) {
      if (removing.has(track.target.nodeId)) delete next.data.tracks[trackId];
    }
    return { mutations: [replaceMutation(next)] };
  }
};

export const moveNodeHandler: OperationHandler = {
  operationType: STANDARD_MOTION_OPERATIONS.moveNode,
  schemaVersion: 1,
  prepare(operation, context) {
    const input = payload(operation);
    if (
      typeof input.documentId !== "string" ||
      typeof input.nodeId !== "string" ||
      !(input.parentNodeId === null || typeof input.parentNodeId === "string") ||
      typeof input.index !== "number" ||
      !Number.isSafeInteger(input.index)
    ) {
      throw new TypeError("move-node payload is invalid");
    }
    const next = cloneJson(
      composition(context, input.documentId) as unknown as JsonValue
    ) as unknown as StandardCompositionDocument;
    if (next.data.nodes[input.nodeId] === undefined) {
      throw new Error(`Node ${input.nodeId} is missing`);
    }
    if (
      input.parentNodeId !== null &&
      (input.parentNodeId === input.nodeId ||
        nodeIsDescendant(next.data.nodes, input.parentNodeId, input.nodeId))
    ) {
      throw new Error("Cannot move a node into its own subtree");
    }
    removeFromHierarchy(next, input.nodeId);
    const children = insertionList(next, input.parentNodeId);
    if (input.index < 0 || input.index > children.length) {
      throw new RangeError(`Move index ${input.index} is out of range`);
    }
    children.splice(input.index, 0, input.nodeId);
    return { mutations: [replaceMutation(next)] };
  }
};

export const setPropertyHandler: OperationHandler = {
  operationType: STANDARD_MOTION_OPERATIONS.setProperty,
  schemaVersion: 1,
  prepare(operation, context) {
    const input = payload(operation);
    if (
      typeof input.documentId !== "string" ||
      typeof input.nodeId !== "string" ||
      typeof input.property !== "string" ||
      input.property.length === 0 ||
      input.binding === null ||
      Array.isArray(input.binding) ||
      typeof input.binding !== "object" ||
      typeof input.binding.kind !== "string"
    ) {
      throw new TypeError("set-property payload is invalid");
    }
    const next = editableComposition(context, input.documentId);
    const node = next.data.nodes[input.nodeId];
    if (node === undefined) throw new Error(`Node ${input.nodeId} is missing`);
    const current = node.properties[input.property];
    const incoming = input.binding as PropertyBinding;
    if (
      current?.kind === "track" &&
      (incoming.kind !== "track" || incoming.trackId !== current.trackId)
    ) {
      throw new Error(
        `Property ${input.nodeId}.${input.property} is animated; remove its track explicitly before replacing the binding`
      );
    }
    if (
      incoming.kind === "track" &&
      (current?.kind !== "track" || current.trackId !== incoming.trackId)
    ) {
      throw new Error("Track bindings must be created through create-track");
    }
    node.properties[input.property] = cloneJson(input.binding) as PropertyBinding;
    return { mutations: [replaceMutation(next)] };
  }
};

export const setNodeAttributesHandler: OperationHandler = {
  operationType: STANDARD_MOTION_OPERATIONS.setNodeAttributes,
  schemaVersion: 1,
  prepare(operation, context) {
    const input = payload(operation);
    const hasName = input.name !== undefined;
    const hasEnabled = input.enabled !== undefined;
    if (
      typeof input.documentId !== "string" ||
      typeof input.nodeId !== "string" ||
      (!hasName && !hasEnabled) ||
      (hasName && (typeof input.name !== "string" || input.name.trim().length === 0)) ||
      (hasEnabled && typeof input.enabled !== "boolean")
    ) {
      throw new TypeError("set-node-attributes payload is invalid");
    }
    const next = cloneJson(
      composition(context, input.documentId) as unknown as JsonValue
    ) as unknown as StandardCompositionDocument;
    const node = next.data.nodes[input.nodeId];
    if (node === undefined) throw new Error(`Node ${input.nodeId} is missing`);
    next.data.nodes[input.nodeId] = {
      ...node,
      ...(hasName ? { name: (input.name as string).trim() } : {}),
      ...(hasEnabled ? { enabled: input.enabled as boolean } : {})
    };
    return { mutations: [replaceMutation(next)] };
  }
};

export const setDurationHandler: OperationHandler = {
  operationType: STANDARD_MOTION_OPERATIONS.setDuration,
  schemaVersion: 1,
  prepare(operation, context) {
    const input = payload(operation);
    if (typeof input.documentId !== "string") {
      throw new TypeError("set-duration requires documentId and duration");
    }
    const next = editableComposition(context, input.documentId);
    const duration = normalizedTime(input.duration, "set-duration duration");
    const durationValue = parseRational(duration.value);
    if (compareRational(durationValue, rational(0)) <= 0) {
      throw new RangeError("Composition duration must be positive");
    }
    for (const track of Object.values(next.data.tracks)) {
      for (const keyframe of Object.values(track.keyframes)) {
        if (keyframe.time.domain !== duration.domain) {
          throw new TypeError(
            `Duration domain ${duration.domain} does not match keyframe ${keyframe.keyframeId}`
          );
        }
        if (compareRational(parseRational(keyframe.time.value), durationValue) > 0) {
          throw new RangeError(
            `Duration cannot end before keyframe ${keyframe.keyframeId} on track ${track.trackId}`
          );
        }
      }
    }
    (next.data as unknown as { duration: SerializedTimeValue }).duration = duration;
    return { mutations: [replaceMutation(next)] };
  }
};

export const createTrackHandler: OperationHandler = {
  operationType: STANDARD_MOTION_OPERATIONS.createTrack,
  schemaVersion: 1,
  prepare(operation, context) {
    const input = payload(operation);
    if (typeof input.documentId !== "string") {
      throw new TypeError("create-track requires documentId and track");
    }
    const track = normalizedTrack(input.track);
    const next = editableComposition(context, input.documentId);
    if (next.data.tracks[track.trackId] !== undefined) {
      throw new Error(`Track ${track.trackId} already exists`);
    }
    const node = next.data.nodes[track.target.nodeId];
    if (node === undefined) {
      throw new Error(`Track target node ${track.target.nodeId} is missing`);
    }
    const current = node.properties[track.target.property];
    if (current?.kind === "track") {
      throw new Error(
        `Property ${track.target.nodeId}.${track.target.property} already uses track ${String(current.trackId)}`
      );
    }
    if (current?.kind === "signal") {
      throw new Error(
        `Property ${track.target.nodeId}.${track.target.property} is signal-driven; replace it explicitly before creating a track`
      );
    }
    for (const keyframe of Object.values(track.keyframes)) {
      assertTimeInComposition(next, keyframe.time, `Keyframe ${keyframe.keyframeId} time`);
      assertUniqueKeyframeTime(track, keyframe, keyframe.keyframeId);
    }
    next.data.tracks[track.trackId] = track;
    node.properties[track.target.property] = {
      kind: "track",
      trackId: track.trackId
    };
    return { mutations: [replaceMutation(next)] };
  }
};

export const removeTrackHandler: OperationHandler = {
  operationType: STANDARD_MOTION_OPERATIONS.removeTrack,
  schemaVersion: 1,
  prepare(operation, context) {
    const input = payload(operation);
    if (
      typeof input.documentId !== "string" ||
      typeof input.trackId !== "string" ||
      !("replacementValue" in input)
    ) {
      throw new TypeError("remove-track requires documentId, trackId and replacementValue");
    }
    const next = editableComposition(context, input.documentId);
    const track = propertyTrack(next, input.trackId);
    const node = next.data.nodes[track.target.nodeId];
    if (node === undefined) throw new Error(`Track target node ${track.target.nodeId} is missing`);
    const binding = node.properties[track.target.property];
    if (binding?.kind !== "track" || binding.trackId !== track.trackId) {
      throw new Error(`Track ${track.trackId} is not bound to its declared target`);
    }
    delete next.data.tracks[track.trackId];
    node.properties[track.target.property] = {
      kind: "constant",
      value: cloneJson(input.replacementValue)
    };
    return { mutations: [replaceMutation(next)] };
  }
};

export const upsertKeyframeHandler: OperationHandler = {
  operationType: STANDARD_MOTION_OPERATIONS.upsertKeyframe,
  schemaVersion: 1,
  prepare(operation, context) {
    const input = payload(operation);
    if (typeof input.documentId !== "string" || typeof input.trackId !== "string") {
      throw new TypeError("upsert-keyframe requires documentId, trackId and keyframe");
    }
    const keyframe = normalizedKeyframe(input.keyframe, "upsert-keyframe keyframe");
    const next = editableComposition(context, input.documentId);
    const track = propertyTrack(next, input.trackId);
    assertTimeInComposition(next, keyframe.time, `Keyframe ${keyframe.keyframeId} time`);
    assertUniqueKeyframeTime(track, keyframe, keyframe.keyframeId);
    track.keyframes[keyframe.keyframeId] = keyframe;
    return { mutations: [replaceMutation(next)] };
  }
};

export const moveKeyframeHandler: OperationHandler = {
  operationType: STANDARD_MOTION_OPERATIONS.moveKeyframe,
  schemaVersion: 1,
  prepare(operation, context) {
    const input = payload(operation);
    if (
      typeof input.documentId !== "string" ||
      typeof input.trackId !== "string" ||
      typeof input.keyframeId !== "string"
    ) {
      throw new TypeError("move-keyframe payload is invalid");
    }
    const next = editableComposition(context, input.documentId);
    const track = propertyTrack(next, input.trackId);
    const current = track.keyframes[input.keyframeId];
    if (current === undefined) throw new Error(`Keyframe ${input.keyframeId} is missing`);
    const moved = {
      ...current,
      time: normalizedTime(input.time, "move-keyframe time")
    } as Keyframe;
    assertTimeInComposition(next, moved.time, `Keyframe ${moved.keyframeId} time`);
    assertUniqueKeyframeTime(track, moved, moved.keyframeId);
    track.keyframes[moved.keyframeId] = moved;
    return { mutations: [replaceMutation(next)] };
  }
};

export const deleteKeyframeHandler: OperationHandler = {
  operationType: STANDARD_MOTION_OPERATIONS.deleteKeyframe,
  schemaVersion: 1,
  prepare(operation, context) {
    const input = payload(operation);
    if (
      typeof input.documentId !== "string" ||
      typeof input.trackId !== "string" ||
      typeof input.keyframeId !== "string"
    ) {
      throw new TypeError("delete-keyframe payload is invalid");
    }
    const next = editableComposition(context, input.documentId);
    const track = propertyTrack(next, input.trackId);
    if (track.keyframes[input.keyframeId] === undefined) {
      throw new Error(`Keyframe ${input.keyframeId} is missing`);
    }
    if (Object.keys(track.keyframes).length === 1) {
      throw new Error(
        `Keyframe ${input.keyframeId} is the last keyframe; remove the track explicitly to create a constant binding`
      );
    }
    delete track.keyframes[input.keyframeId];
    return { mutations: [replaceMutation(next)] };
  }
};

export const setKeyframeEasingHandler: OperationHandler = {
  operationType: STANDARD_MOTION_OPERATIONS.setKeyframeEasing,
  schemaVersion: 1,
  prepare(operation, context) {
    const input = payload(operation);
    if (
      typeof input.documentId !== "string" ||
      typeof input.trackId !== "string" ||
      typeof input.keyframeId !== "string" ||
      !(input.easing === null || (typeof input.easing === "object" && !Array.isArray(input.easing)))
    ) {
      throw new TypeError("set-keyframe-easing payload is invalid");
    }
    const next = editableComposition(context, input.documentId);
    const track = propertyTrack(next, input.trackId);
    const current = track.keyframes[input.keyframeId];
    if (current === undefined) throw new Error(`Keyframe ${input.keyframeId} is missing`);
    if (input.easing === null) {
      const { easing: _easing, ...withoutEasing } = current;
      track.keyframes[input.keyframeId] = withoutEasing as Keyframe;
    } else {
      track.keyframes[input.keyframeId] = {
        ...current,
        easing: cloneJson(input.easing) as NonNullable<Keyframe["easing"]>
      };
    }
    return { mutations: [replaceMutation(next)] };
  }
};

export const standardMotionOperationHandlers: readonly OperationHandler[] = [
  insertNodeHandler,
  removeNodeHandler,
  moveNodeHandler,
  setNodeAttributesHandler,
  setPropertyHandler,
  setDurationHandler,
  createTrackHandler,
  removeTrackHandler,
  upsertKeyframeHandler,
  moveKeyframeHandler,
  deleteKeyframeHandler,
  setKeyframeEasingHandler
];
