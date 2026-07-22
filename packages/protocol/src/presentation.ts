import type { JsonObject } from "./json.js";
import type { Rational, TimeValue } from "./rational.js";

export const PRESENTATION_GRAPH_VERSION = 1;

export const STANDARD_PRESENTATION_PRIMITIVES = {
  group: "org.kineweave.presentation/group",
  text: "org.kineweave.presentation/text",
  custom: "org.kineweave.presentation/custom"
} as const;

export const STANDARD_COLOR_SPACES = {
  srgb: "org.kineweave.color/srgb"
} as const;

export interface PresentationTransform {
  readonly translation: number[];
  readonly scale: number[];
  readonly rotation: number;
  readonly anchor: number[];
}

export interface PresentationNode {
  readonly presentationId: string;
  readonly primitive: string;
  readonly children: string[];
  readonly visible: boolean;
  readonly opacity: number;
  readonly transform: PresentationTransform;
  readonly sourceResourceUri?: string;
  readonly data: JsonObject;
}

export interface PresentationViewport {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: Rational;
}

export interface ResolvedPresentationGraph {
  readonly presentationGraphVersion: number;
  readonly documentId: string;
  readonly time: TimeValue;
  readonly viewport: PresentationViewport;
  readonly colorSpace: string;
  readonly background: string | null;
  readonly rootNodeIds: string[];
  readonly nodes: Readonly<Record<string, PresentationNode>>;
  /** Includes every node primitive, the color space, and additional semantic features. */
  readonly requiredFeatures: string[];
  readonly metadata?: JsonObject;
}
