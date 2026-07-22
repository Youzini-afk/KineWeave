import type { EvaluationMode } from "./capability.js";
import type { JsonValue } from "./json.js";
import type { Rational, TimeValue } from "./rational.js";

export type EvaluationStateReference =
  | { readonly kind: "branch"; readonly branchName: string }
  | { readonly kind: "commit"; readonly commitId: string };

export interface EvaluationViewport {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: Rational;
}

export interface EvaluationRequest {
  readonly documentId: string;
  readonly state?: EvaluationStateReference;
  readonly time: TimeValue;
  readonly mode: EvaluationMode;
  readonly viewport: EvaluationViewport;
  readonly colorSpace: string;
  readonly locale: string;
  readonly randomSeed: string;
  readonly outputProfileId?: string;
  readonly externalSignals: Readonly<Record<string, JsonValue>>;
  readonly capabilityBindings?: Readonly<Record<string, string>>;
}
