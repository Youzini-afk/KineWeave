import type { EvaluationExecutionResult } from "@kineweave/evaluation-engine";
import {
  addRational,
  compareRational,
  type EvaluationRequest,
  type EvaluationStateReference,
  multiplyRational,
  parseRational,
  type Rational,
  rational,
  STANDARD_TIME_DOMAINS,
  subtractRational,
  type TimeValue,
  timeValue
} from "@kineweave/protocol";
import type {
  OutputRenderExecutionRequest,
  OutputRenderExecutionResult
} from "@kineweave/render-engine";
import type { ProjectSession } from "./project-session.js";

export interface OutputFramePlanInput {
  readonly startTime: Rational;
  readonly endTimeExclusive: Rational;
  readonly framesPerSecond: Rational;
}

export interface OutputFramePlan extends OutputFramePlanInput {
  readonly frameCount: number;
}

export interface OutputFrame {
  readonly frameIndex: number;
  readonly time: TimeValue;
}

export interface OutputFrameSequenceRequest {
  readonly plan: OutputFramePlan;
  readonly evaluation: Omit<EvaluationRequest, "time" | "mode">;
  readonly rendering: Omit<OutputRenderExecutionRequest, "graph" | "evaluationMode">;
  readonly signal?: AbortSignal;
}

export interface OutputFrameSequenceResult extends OutputFrame {
  readonly sourceCommitId: string;
  readonly evaluation: EvaluationExecutionResult;
  readonly rendering: OutputRenderExecutionResult;
}

export function createOutputFramePlan(input: OutputFramePlanInput): OutputFramePlan {
  const startTime = parseRational(input.startTime);
  const endTimeExclusive = parseRational(input.endTimeExclusive);
  const framesPerSecond = parseRational(input.framesPerSecond);
  if (compareRational(startTime, rational(0)) < 0) {
    throw new RangeError("Output frame sequence start time cannot be negative");
  }
  if (compareRational(endTimeExclusive, startTime) <= 0) {
    throw new RangeError("Output frame sequence end time must be after its start time");
  }
  if (compareRational(framesPerSecond, rational(0)) <= 0) {
    throw new RangeError("Output frame sequence rate must be positive");
  }

  const exactFrameCount = multiplyRational(
    subtractRational(endTimeExclusive, startTime),
    framesPerSecond
  );
  const numerator = BigInt(exactFrameCount.numerator);
  const denominator = BigInt(exactFrameCount.denominator);
  const frameCount = (numerator + denominator - 1n) / denominator;
  if (frameCount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Output frame sequence contains too many frames");
  }
  return {
    startTime,
    endTimeExclusive,
    framesPerSecond,
    frameCount: Number(frameCount)
  };
}

export function outputFrameAt(plan: OutputFramePlan, frameIndex: number): OutputFrame {
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= plan.frameCount) {
    throw new RangeError(`Output frame index ${frameIndex} is outside the frame plan`);
  }
  return {
    frameIndex,
    time: timeValue(
      addRational(
        plan.startTime,
        rational(
          BigInt(frameIndex) * BigInt(plan.framesPerSecond.denominator),
          plan.framesPerSecond.numerator
        )
      ),
      STANDARD_TIME_DOMAINS.seconds
    )
  };
}

function sourceCommitId(
  session: ProjectSession,
  state: EvaluationStateReference | undefined
): string {
  if (state?.kind === "commit") {
    if (!session.history.hasCommit(state.commitId)) {
      throw new Error(`Unknown commit ${state.commitId}`);
    }
    return state.commitId;
  }
  return session.history.getBranchHead(state?.branchName ?? session.history.mainBranchName);
}

export function renderOutputFrames(
  session: ProjectSession,
  request: OutputFrameSequenceRequest
): AsyncGenerator<OutputFrameSequenceResult> {
  const plan = createOutputFramePlan(request.plan);
  const commitId = sourceCommitId(session, request.evaluation.state);
  const evaluationRequest = structuredClone(request.evaluation);
  const renderingRequest = structuredClone(request.rendering);

  return (async function* frames() {
    for (let frameIndex = 0; frameIndex < plan.frameCount; frameIndex += 1) {
      request.signal?.throwIfAborted();
      const frame = outputFrameAt(plan, frameIndex);
      const evaluation = await session.evaluate({
        ...evaluationRequest,
        state: { kind: "commit", commitId },
        time: frame.time,
        mode: "deterministic"
      });
      request.signal?.throwIfAborted();
      const rendering = await session.renderOutput({
        ...renderingRequest,
        graph: evaluation.graph,
        evaluationMode: "deterministic"
      });
      request.signal?.throwIfAborted();
      yield { ...frame, sourceCommitId: commitId, evaluation, rendering };
    }
  })();
}
