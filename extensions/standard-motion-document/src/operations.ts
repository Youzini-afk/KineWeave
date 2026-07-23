import { cloneJson, type JsonObject, type JsonValue, type Operation } from "@kineweave/protocol";
import type { OperationHandler, OperationReadContext } from "@kineweave/transaction-engine";
import {
  type MotionNode,
  type PropertyBinding,
  STANDARD_COMPOSITION_TYPE,
  type StandardCompositionDocument
} from "./model.js";
import { nodeIsDescendant } from "./validation.js";

export const STANDARD_MOTION_OPERATIONS = {
  insertNode: "org.kineweave.standard-motion/insert-node",
  removeNode: "org.kineweave.standard-motion/remove-node",
  moveNode: "org.kineweave.standard-motion/move-node",
  setNodeAttributes: "org.kineweave.standard-motion/set-node-attributes",
  setProperty: "org.kineweave.standard-motion/set-property"
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
    const next = cloneJson(
      composition(context, input.documentId) as unknown as JsonValue
    ) as unknown as StandardCompositionDocument;
    const node = next.data.nodes[input.nodeId];
    if (node === undefined) throw new Error(`Node ${input.nodeId} is missing`);
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

export const standardMotionOperationHandlers: readonly OperationHandler[] = [
  insertNodeHandler,
  removeNodeHandler,
  moveNodeHandler,
  setNodeAttributesHandler,
  setPropertyHandler
];
