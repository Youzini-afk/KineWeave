import {
  PRESENTATION_GRAPH_VERSION,
  STANDARD_PRESENTATION_PRIMITIVES,
  assertJsonValue,
  assertQualifiedName,
  assertStableId,
  compareRational,
  parseRational,
  parseResourceUri,
  rational,
  timeValue,
  type Diagnostic,
  type PresentationNode,
  type Rational,
  type ResolvedPresentationGraph
} from "@kineweave/protocol";

type UnknownRecord = Record<string, unknown>;

interface ValidatedNodeShape {
  readonly node: PresentationNode;
  readonly children: readonly string[];
  readonly primitive: string | undefined;
  readonly semanticFeatures: readonly string[];
}

function error(code: string, message: string, jsonPointer?: string): Diagnostic {
  return {
    severity: "error",
    code,
    message,
    ...(jsonPointer === undefined ? {} : { jsonPointer }),
    source: "@kineweave/evaluation-engine"
  };
}

function isPlainObject(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function finiteVector2(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

function readIdArray(
  value: unknown,
  label: string,
  jsonPointer: string,
  duplicateCode: string,
  diagnostics: Diagnostic[]
): readonly string[] {
  if (!Array.isArray(value)) {
    diagnostics.push(
      error("presentation.hierarchy.references-invalid", `${label} must be an array`, jsonPointer)
    );
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemPointer = `${jsonPointer}/${index}`;
    if (typeof item !== "string") {
      diagnostics.push(
        error(
          "presentation.hierarchy.reference-invalid",
          `${label} entries must be stable IDs`,
          itemPointer
        )
      );
      continue;
    }
    try {
      assertStableId(item, "presentation node id");
    } catch (caught) {
      diagnostics.push(
        error(
          "presentation.hierarchy.reference-invalid",
          caught instanceof Error ? caught.message : String(caught),
          itemPointer
        )
      );
      continue;
    }
    if (seen.has(item)) {
      diagnostics.push(
        error(duplicateCode, `${label} contains duplicate node ${item}`, itemPointer)
      );
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

function validateNode(
  nodeId: string,
  rawNode: unknown,
  diagnostics: Diagnostic[]
): ValidatedNodeShape | undefined {
  const nodePointer = `/nodes/${pointerSegment(nodeId)}`;
  if (!isPlainObject(rawNode)) {
    diagnostics.push(
      error(
        "presentation.node.invalid",
        `Presentation node ${nodeId} must be an object`,
        nodePointer
      )
    );
    return undefined;
  }

  const presentationId = rawNode.presentationId;
  if (typeof presentationId !== "string") {
    diagnostics.push(
      error(
        "presentation.node.id-invalid",
        `Node ${nodeId} requires a presentationId`,
        `${nodePointer}/presentationId`
      )
    );
  } else {
    try {
      assertStableId(presentationId, "presentation id");
      if (presentationId !== nodeId) {
        diagnostics.push(
          error(
            "presentation.node.id-mismatch",
            `Node key ${nodeId} does not match presentationId ${presentationId}`,
            `${nodePointer}/presentationId`
          )
        );
      }
    } catch (caught) {
      diagnostics.push(
        error(
          "presentation.node.id-invalid",
          caught instanceof Error ? caught.message : String(caught),
          `${nodePointer}/presentationId`
        )
      );
    }
  }

  let primitive: string | undefined;
  if (typeof rawNode.primitive !== "string") {
    diagnostics.push(
      error(
        "presentation.node.primitive-invalid",
        `Node ${nodeId} requires a primitive`,
        `${nodePointer}/primitive`
      )
    );
  } else {
    try {
      assertQualifiedName(rawNode.primitive, "presentation primitive");
      primitive = rawNode.primitive;
    } catch (caught) {
      diagnostics.push(
        error(
          "presentation.node.primitive-invalid",
          caught instanceof Error ? caught.message : String(caught),
          `${nodePointer}/primitive`
        )
      );
    }
  }

  const children = readIdArray(
    rawNode.children,
    `Children of presentation node ${nodeId}`,
    `${nodePointer}/children`,
    "presentation.hierarchy.child-duplicate",
    diagnostics
  );

  if (typeof rawNode.visible !== "boolean") {
    diagnostics.push(
      error(
        "presentation.node.visibility-invalid",
        `Node ${nodeId} visible must be boolean`,
        `${nodePointer}/visible`
      )
    );
  }
  if (
    typeof rawNode.opacity !== "number" ||
    !Number.isFinite(rawNode.opacity) ||
    rawNode.opacity < 0 ||
    rawNode.opacity > 1
  ) {
    diagnostics.push(
      error(
        "presentation.node.opacity-invalid",
        `Node ${nodeId} opacity must be between 0 and 1`,
        `${nodePointer}/opacity`
      )
    );
  }

  const transform = rawNode.transform;
  if (
    !isPlainObject(transform) ||
    !finiteVector2(transform.translation) ||
    !finiteVector2(transform.scale) ||
    !finiteVector2(transform.anchor) ||
    typeof transform.rotation !== "number" ||
    !Number.isFinite(transform.rotation)
  ) {
    diagnostics.push(
      error(
        "presentation.node.transform-invalid",
        `Node ${nodeId} has an invalid transform`,
        `${nodePointer}/transform`
      )
    );
  }

  if (rawNode.sourceResourceUri !== undefined) {
    if (typeof rawNode.sourceResourceUri !== "string") {
      diagnostics.push(
        error(
          "presentation.node.source-uri-invalid",
          `Node ${nodeId} sourceResourceUri must be a string`,
          `${nodePointer}/sourceResourceUri`
        )
      );
    } else {
      try {
        parseResourceUri(rawNode.sourceResourceUri);
      } catch (caught) {
        diagnostics.push(
          error(
            "presentation.node.source-uri-invalid",
            caught instanceof Error ? caught.message : String(caught),
            `${nodePointer}/sourceResourceUri`
          )
        );
      }
    }
  }

  if (!isPlainObject(rawNode.data)) {
    diagnostics.push(
      error(
        "presentation.node.data-invalid",
        `Presentation node ${nodeId} data must be a JSON object`,
        `${nodePointer}/data`
      )
    );
  } else {
    try {
      assertJsonValue(rawNode.data, `presentation node ${nodeId} data`);
    } catch (caught) {
      diagnostics.push(
        error(
          "presentation.node.data-invalid",
          caught instanceof Error ? caught.message : String(caught),
          `${nodePointer}/data`
        )
      );
    }
  }

  const semanticFeatures: string[] = [];
  if (primitive === STANDARD_PRESENTATION_PRIMITIVES.text) {
    if (children.length > 0) {
      diagnostics.push(
        error(
          "presentation.node.children-unsupported",
          `Text node ${nodeId} cannot contain child nodes`,
          `${nodePointer}/children`
        )
      );
    }
    if (isPlainObject(rawNode.data)) {
      if (typeof rawNode.data.text !== "string") {
        diagnostics.push(
          error(
            "presentation.text.text-invalid",
            `Text node ${nodeId} requires string data.text`,
            `${nodePointer}/data/text`
          )
        );
      }
      if (
        typeof rawNode.data.fontSize !== "number" ||
        !Number.isFinite(rawNode.data.fontSize) ||
        rawNode.data.fontSize <= 0
      ) {
        diagnostics.push(
          error(
            "presentation.text.font-size-invalid",
            `Text node ${nodeId} requires a positive finite data.fontSize`,
            `${nodePointer}/data/fontSize`
          )
        );
      }
      for (const key of [
        "fill",
        "fontFamily",
        "textAnchor",
        "dominantBaseline"
      ] as const) {
        if (rawNode.data[key] !== undefined && typeof rawNode.data[key] !== "string") {
          diagnostics.push(
            error(
              "presentation.text.style-invalid",
              `Text node ${nodeId} data.${key} must be a string`,
              `${nodePointer}/data/${key}`
            )
          );
        }
      }
    }
  }
  if (primitive === STANDARD_PRESENTATION_PRIMITIVES.custom) {
    if (isPlainObject(rawNode.data)) {
      if (typeof rawNode.data.packetType !== "string") {
        diagnostics.push(
          error(
            "presentation.custom.packet-type-invalid",
            `Custom node ${nodeId} requires data.packetType`,
            `${nodePointer}/data/packetType`
          )
        );
      } else {
        try {
          assertQualifiedName(rawNode.data.packetType, "custom presentation packet type");
          semanticFeatures.push(rawNode.data.packetType);
        } catch (caught) {
          diagnostics.push(
            error(
              "presentation.custom.packet-type-invalid",
              caught instanceof Error ? caught.message : String(caught),
              `${nodePointer}/data/packetType`
            )
          );
        }
      }
      if (
        !Number.isSafeInteger(rawNode.data.schemaVersion) ||
        (rawNode.data.schemaVersion as number) < 1
      ) {
        diagnostics.push(
          error(
            "presentation.custom.schema-version-invalid",
            `Custom node ${nodeId} requires a positive integer data.schemaVersion`,
            `${nodePointer}/data/schemaVersion`
          )
        );
      }
      for (const key of ["nodeData", "properties"] as const) {
        if (!isPlainObject(rawNode.data[key])) {
          diagnostics.push(
            error(
              "presentation.custom.data-invalid",
              `Custom node ${nodeId} data.${key} must be a JSON object`,
              `${nodePointer}/data/${key}`
            )
          );
        }
      }
    }
  }

  return {
    node: rawNode as unknown as PresentationNode,
    children,
    primitive,
    semanticFeatures
  };
}

export function validatePresentationGraph(
  rawGraph: unknown
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!isPlainObject(rawGraph)) {
    return [
      error(
        "presentation.graph.invalid",
        "Presentation graph must be a JSON object",
        "/"
      )
    ];
  }

  try {
    assertJsonValue(rawGraph, "presentation graph");
  } catch (caught) {
    diagnostics.push(
      error(
        "presentation.graph.json-invalid",
        caught instanceof Error ? caught.message : String(caught),
        "/"
      )
    );
  }

  if (rawGraph.presentationGraphVersion !== PRESENTATION_GRAPH_VERSION) {
    diagnostics.push(
      error(
        "presentation.version.unsupported",
        `Presentation graph version ${String(rawGraph.presentationGraphVersion)} is not ${PRESENTATION_GRAPH_VERSION}`,
        "/presentationGraphVersion"
      )
    );
  }

  if (typeof rawGraph.documentId !== "string") {
    diagnostics.push(
      error(
        "presentation.document-id.invalid",
        "Presentation graph requires a documentId",
        "/documentId"
      )
    );
  } else {
    try {
      assertStableId(rawGraph.documentId, "presentation document id");
    } catch (caught) {
      diagnostics.push(
        error(
          "presentation.document-id.invalid",
          caught instanceof Error ? caught.message : String(caught),
          "/documentId"
        )
      );
    }
  }

  const viewport = rawGraph.viewport;
  if (
    !isPlainObject(viewport) ||
    !Number.isSafeInteger(viewport.width) ||
    (viewport.width as number) <= 0 ||
    !Number.isSafeInteger(viewport.height) ||
    (viewport.height as number) <= 0
  ) {
    diagnostics.push(
      error(
        "presentation.viewport.invalid",
        "Presentation viewport dimensions must be positive integers",
        "/viewport"
      )
    );
  }
  if (!isPlainObject(viewport)) {
    diagnostics.push(
      error(
        "presentation.viewport.pixel-ratio-invalid",
        "Presentation viewport requires a pixelRatio",
        "/viewport/pixelRatio"
      )
    );
  } else {
    try {
      if (
        compareRational(
          parseRational(viewport.pixelRatio as Rational),
          rational(0)
        ) <= 0
      ) {
        throw new RangeError("Pixel ratio must be positive");
      }
    } catch (caught) {
      diagnostics.push(
        error(
          "presentation.viewport.pixel-ratio-invalid",
          caught instanceof Error ? caught.message : String(caught),
          "/viewport/pixelRatio"
        )
      );
    }
  }

  const graphTime = rawGraph.time;
  if (!isPlainObject(graphTime) || typeof graphTime.domain !== "string") {
    diagnostics.push(
      error(
        "presentation.time.invalid",
        "Presentation graph requires a valid time value",
        "/time"
      )
    );
  } else {
    try {
      timeValue(parseRational(graphTime.value as Rational), graphTime.domain);
    } catch (caught) {
      diagnostics.push(
        error(
          "presentation.time.invalid",
          caught instanceof Error ? caught.message : String(caught),
          "/time"
        )
      );
    }
  }

  if (typeof rawGraph.colorSpace !== "string") {
    diagnostics.push(
      error(
        "presentation.color-space.invalid",
        "Presentation graph requires a colorSpace",
        "/colorSpace"
      )
    );
  } else {
    try {
      assertQualifiedName(rawGraph.colorSpace, "presentation color space");
    } catch (caught) {
      diagnostics.push(
        error(
          "presentation.color-space.invalid",
          caught instanceof Error ? caught.message : String(caught),
          "/colorSpace"
        )
      );
    }
  }

  if (rawGraph.background !== null && typeof rawGraph.background !== "string") {
    diagnostics.push(
      error(
        "presentation.background.invalid",
        "Presentation background must be a color string or null",
        "/background"
      )
    );
  }

  if (rawGraph.metadata !== undefined) {
    if (!isPlainObject(rawGraph.metadata)) {
      diagnostics.push(
        error(
          "presentation.metadata.invalid",
          "Presentation metadata must be a JSON object",
          "/metadata"
        )
      );
    } else {
      try {
        assertJsonValue(rawGraph.metadata, "presentation metadata");
      } catch (caught) {
        diagnostics.push(
          error(
            "presentation.metadata.invalid",
            caught instanceof Error ? caught.message : String(caught),
            "/metadata"
          )
        );
      }
    }
  }

  const rootNodeIds = readIdArray(
    rawGraph.rootNodeIds,
    "Presentation rootNodeIds",
    "/rootNodeIds",
    "presentation.hierarchy.root-duplicate",
    diagnostics
  );

  const validatedNodes = new Map<string, ValidatedNodeShape>();
  if (!isPlainObject(rawGraph.nodes)) {
    diagnostics.push(
      error("presentation.nodes.invalid", "Presentation nodes must be an object", "/nodes")
    );
  } else {
    for (const [nodeId, node] of Object.entries(rawGraph.nodes)) {
      try {
        assertStableId(nodeId, "presentation node map key");
      } catch (caught) {
        diagnostics.push(
          error(
            "presentation.node.key-invalid",
            caught instanceof Error ? caught.message : String(caught),
            `/nodes/${pointerSegment(nodeId)}`
          )
        );
      }
      const validated = validateNode(nodeId, node, diagnostics);
      if (validated !== undefined) validatedNodes.set(nodeId, validated);
    }
  }

  const owners = new Map<string, string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string, owner: string): void => {
    const node = validatedNodes.get(nodeId);
    if (node === undefined) {
      diagnostics.push(
        error(
          "presentation.hierarchy.node-missing",
          `Presentation hierarchy references missing or invalid node ${nodeId}`
        )
      );
      return;
    }
    if (visiting.has(nodeId)) {
      diagnostics.push(
        error(
          "presentation.hierarchy.cycle",
          `Presentation hierarchy cycle detected at ${nodeId}`
        )
      );
      return;
    }
    const existingOwner = owners.get(nodeId);
    if (existingOwner !== undefined && existingOwner !== owner) {
      diagnostics.push(
        error(
          "presentation.hierarchy.multiple-parents",
          `Presentation node ${nodeId} belongs to both ${existingOwner} and ${owner}`
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
  };
  for (const rootNodeId of rootNodeIds) visit(rootNodeId, "$root");
  for (const nodeId of validatedNodes.keys()) {
    if (!owners.has(nodeId)) {
      diagnostics.push(
        error(
          "presentation.hierarchy.orphan",
          `Presentation node ${nodeId} is not reachable from rootNodeIds`,
          `/nodes/${pointerSegment(nodeId)}`
        )
      );
    }
  }

  const features = new Set<string>();
  if (!Array.isArray(rawGraph.requiredFeatures)) {
    diagnostics.push(
      error(
        "presentation.features.invalid",
        "Presentation requiredFeatures must be an array",
        "/requiredFeatures"
      )
    );
  } else {
    for (const [index, feature] of rawGraph.requiredFeatures.entries()) {
      if (typeof feature !== "string") {
        diagnostics.push(
          error(
            "presentation.feature.invalid",
            "Presentation features must be qualified names",
            `/requiredFeatures/${index}`
          )
        );
        continue;
      }
      try {
        assertQualifiedName(feature, "presentation feature");
      } catch (caught) {
        diagnostics.push(
          error(
            "presentation.feature.invalid",
            caught instanceof Error ? caught.message : String(caught),
            `/requiredFeatures/${index}`
          )
        );
      }
      if (features.has(feature)) {
        diagnostics.push(
          error(
            "presentation.feature.duplicate",
            `Duplicate presentation feature ${feature}`,
            `/requiredFeatures/${index}`
          )
        );
      }
      features.add(feature);
    }
  }
  for (const [nodeId, node] of validatedNodes) {
    if (node.primitive !== undefined && !features.has(node.primitive)) {
      diagnostics.push(
        error(
          "presentation.feature.primitive-missing",
          `Node ${nodeId} primitive ${node.primitive} is missing from requiredFeatures`,
          `/nodes/${pointerSegment(nodeId)}/primitive`
        )
      );
    }
    for (const semanticFeature of node.semanticFeatures) {
      if (!features.has(semanticFeature)) {
        diagnostics.push(
          error(
            "presentation.feature.semantic-missing",
            `Node ${nodeId} semantic feature ${semanticFeature} is missing from requiredFeatures`,
            `/nodes/${pointerSegment(nodeId)}/data/packetType`
          )
        );
      }
    }
  }
  if (
    typeof rawGraph.colorSpace === "string" &&
    !features.has(rawGraph.colorSpace)
  ) {
    diagnostics.push(
      error(
        "presentation.feature.color-space-missing",
        `Color space ${rawGraph.colorSpace} is missing from requiredFeatures`,
        "/colorSpace"
      )
    );
  }

  return diagnostics;
}

export function isResolvedPresentationGraph(
  value: unknown
): value is ResolvedPresentationGraph {
  return !validatePresentationGraph(value).some(
    (item) => item.severity === "error"
  );
}
