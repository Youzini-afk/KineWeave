import {
  STANDARD_COLOR_SPACES,
  STANDARD_TIME_DOMAINS,
  rational,
  type JsonObject,
  type JsonValue,
  type ProjectDocumentEnvelope,
  type Rational,
  type TimeValue
} from "@kineweave/protocol";

export const STANDARD_COMPOSITION_TYPE =
  "org.kineweave.standard-motion/composition";
export const STANDARD_COMPOSITION_SCHEMA_VERSION = 2;
export const STANDARD_NODE_SCHEMA_VERSION = 2;
export const STANDARD_SIGNAL_SCHEMA_VERSION = 1;

export const STANDARD_NODE_TYPES = {
  group: "org.kineweave.standard-motion/group",
  text: "org.kineweave.standard-motion/text",
  rectangle: "org.kineweave.standard-motion/rectangle",
  ellipse: "org.kineweave.standard-motion/ellipse",
  path: "org.kineweave.standard-motion/path"
} as const;

export const STANDARD_VALUE_TYPES = {
  string: "org.kineweave.value/string",
  number: "org.kineweave.value/number",
  vector2: "org.kineweave.value/vector2",
  color: "org.kineweave.value/color",
  boolean: "org.kineweave.value/boolean"
} as const;

export const STANDARD_SIGNAL_TYPES = {
  external: "org.kineweave.standard-motion/external-signal"
} as const;

export const STANDARD_KEYFRAME_EASINGS = {
  linear: "linear",
  hold: "hold",
  cubicBezier: "cubic-bezier"
} as const;

export type SerializedRational = Rational & JsonObject;
export type SerializedTimeValue = TimeValue & JsonObject;

export type PropertyBinding = JsonObject & {
  readonly kind: string;
};

export type ConstantPropertyBinding = PropertyBinding & {
  readonly kind: "constant";
  readonly value: JsonValue;
};

export type TrackPropertyBinding = PropertyBinding & {
  readonly kind: "track";
  readonly trackId: string;
};

export type SignalPropertyBinding = PropertyBinding & {
  readonly kind: "signal";
  readonly signalId: string;
};

export interface MotionNode extends JsonObject {
  readonly nodeId: string;
  readonly nodeType: string;
  readonly schemaVersion: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly children: string[];
  readonly properties: Record<string, PropertyBinding>;
  readonly data: JsonObject;
}

export interface Keyframe extends JsonObject {
  readonly keyframeId: string;
  readonly time: SerializedTimeValue;
  readonly value: JsonValue;
  readonly easing?: JsonObject & {
    readonly kind: string;
  };
}

export interface PropertyTrack extends JsonObject {
  readonly trackId: string;
  readonly valueType: string;
  readonly target: JsonObject & {
    readonly nodeId: string;
    readonly property: string;
  };
  readonly keyframes: Record<string, Keyframe>;
}

export interface MotionSignal extends JsonObject {
  readonly signalId: string;
  readonly signalType: string;
  readonly schemaVersion: number;
  readonly valueType: string;
  readonly data: JsonObject;
}

export interface StandardCompositionData extends JsonObject {
  readonly name: string;
  readonly duration: SerializedTimeValue;
  readonly canvas: JsonObject & {
    readonly width: number;
    readonly height: number;
    readonly pixelAspectRatio: SerializedRational;
    readonly colorSpace: string;
    readonly background?: PropertyBinding;
  };
  readonly rootNodeIds: string[];
  readonly nodes: Record<string, MotionNode>;
  readonly tracks: Record<string, PropertyTrack>;
  readonly signals: Record<string, MotionSignal>;
  readonly metadata?: JsonObject;
}

export type StandardCompositionDocument = ProjectDocumentEnvelope<StandardCompositionData>;

export function serializedRational(value: Rational): SerializedRational {
  return { ...value } as SerializedRational;
}

export function serializedTime(value: TimeValue): SerializedTimeValue {
  return {
    value: serializedRational(value.value),
    domain: value.domain
  } as SerializedTimeValue;
}

export function constant(value: JsonValue): ConstantPropertyBinding {
  return { kind: "constant", value };
}

export function createExternalSignal(
  signalId: string,
  key: string,
  valueType: string,
  defaultValue?: JsonValue
): MotionSignal {
  return {
    signalId,
    signalType: STANDARD_SIGNAL_TYPES.external,
    schemaVersion: STANDARD_SIGNAL_SCHEMA_VERSION,
    valueType,
    data: {
      key,
      ...(defaultValue === undefined ? {} : { defaultValue })
    }
  };
}

export function createTextNode(
  nodeId: string,
  text = "Hello KineWeave"
): MotionNode {
  return {
    nodeId,
    nodeType: STANDARD_NODE_TYPES.text,
    schemaVersion: STANDARD_NODE_SCHEMA_VERSION,
    name: "Text",
    enabled: true,
    children: [],
    properties: {
      content: constant(text),
      position: constant([960, 540]),
      fontSize: constant(96),
      fill: constant("#ffffff")
    },
    data: {}
  };
}

export function createGroupNode(nodeId: string, name = "Group"): MotionNode {
  return {
    nodeId,
    nodeType: STANDARD_NODE_TYPES.group,
    schemaVersion: STANDARD_NODE_SCHEMA_VERSION,
    name,
    enabled: true,
    children: [],
    properties: {},
    data: {}
  };
}

function createShapeNode(
  nodeId: string,
  nodeType: string,
  name: string,
  size: readonly [number, number]
): MotionNode {
  return {
    nodeId,
    nodeType,
    schemaVersion: STANDARD_NODE_SCHEMA_VERSION,
    name,
    enabled: true,
    children: [],
    properties: {
      position: constant([0, 0]),
      size: constant([...size]),
      fill: constant("#ffffff"),
      stroke: constant("#00000000"),
      strokeWidth: constant(0)
    },
    data: {}
  };
}

export function createRectangleNode(
  nodeId: string,
  width = 320,
  height = 180
): MotionNode {
  const node = createShapeNode(
    nodeId,
    STANDARD_NODE_TYPES.rectangle,
    "Rectangle",
    [width, height]
  );
  node.properties.cornerRadius = constant(0);
  return node;
}

export function createEllipseNode(
  nodeId: string,
  width = 180,
  height = 180
): MotionNode {
  return createShapeNode(
    nodeId,
    STANDARD_NODE_TYPES.ellipse,
    "Ellipse",
    [width, height]
  );
}

export function createPathNode(nodeId: string, path: string): MotionNode {
  return {
    nodeId,
    nodeType: STANDARD_NODE_TYPES.path,
    schemaVersion: STANDARD_NODE_SCHEMA_VERSION,
    name: "Path",
    enabled: true,
    children: [],
    properties: {
      position: constant([0, 0]),
      path: constant(path),
      fill: constant("#ffffff"),
      stroke: constant("#00000000"),
      strokeWidth: constant(0)
    },
    data: {}
  };
}

export function cubicBezierEasing(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): JsonObject & { readonly kind: typeof STANDARD_KEYFRAME_EASINGS.cubicBezier } {
  return { kind: STANDARD_KEYFRAME_EASINGS.cubicBezier, x1, y1, x2, y2 };
}

export function createStandardComposition(
  documentId = "document_main",
  name = "Main Composition"
): StandardCompositionDocument {
  const headline = createTextNode("node_headline");
  headline.properties.position = constant([960, 620]);
  headline.properties.fontSize = constant(88);
  const panel = createRectangleNode("node_panel", 1280, 480);
  panel.properties.position = constant([960, 540]);
  panel.properties.fill = constant("#20283c");
  panel.properties.stroke = constant("#405175");
  panel.properties.strokeWidth = constant(4);
  panel.properties.cornerRadius = constant(48);
  const orbit = createEllipseNode("node_orbit", 560, 560);
  orbit.properties.position = constant([960, 540]);
  orbit.properties.fill = constant("#00000000");
  orbit.properties.stroke = constant("#5b7cff");
  orbit.properties.strokeWidth = constant(10);
  orbit.properties.opacity = constant(0.7);
  const mark = createPathNode(
    "node_mark",
    "M 0 -72 L 62 0 L 0 72 L -62 0 Z"
  );
  mark.properties.position = constant([960, 430]);
  mark.properties.fill = constant("#8ea3ff");
  const scene = createGroupNode("node_scene", "Scene");
  scene.children.push(panel.nodeId, orbit.nodeId, mark.nodeId, headline.nodeId);
  return {
    documentId,
    documentType: STANDARD_COMPOSITION_TYPE,
    schemaVersion: STANDARD_COMPOSITION_SCHEMA_VERSION,
    data: {
      name,
      duration: serializedTime({
        value: rational(5),
        domain: STANDARD_TIME_DOMAINS.seconds
      }),
      canvas: {
        width: 1920,
        height: 1080,
        pixelAspectRatio: serializedRational(rational(1)),
        colorSpace: STANDARD_COLOR_SPACES.srgb,
        background: constant("#111318")
      },
      rootNodeIds: [scene.nodeId],
      nodes: {
        [scene.nodeId]: scene,
        [panel.nodeId]: panel,
        [orbit.nodeId]: orbit,
        [mark.nodeId]: mark,
        [headline.nodeId]: headline
      },
      tracks: {},
      signals: {}
    }
  };
}
