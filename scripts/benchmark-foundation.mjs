import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  createOfficialDistributionProfile,
  KINEWEAVE_VERSION
} from "@kineweave/official-distribution";
import { canonicalStringify } from "@kineweave/project-format";
import { NodeProjectRepository } from "@kineweave/project-repository-node";
import { ProjectSession } from "@kineweave/project-session";
import {
  rational,
  STANDARD_COLOR_SPACES,
  STANDARD_TIME_DOMAINS,
  timeValue
} from "@kineweave/protocol";
import {
  STANDARD_KEYFRAME_EASINGS,
  STANDARD_MOTION_OPERATIONS,
  serializedTime
} from "@kineweave/standard-motion-document";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(repositoryRoot, "benchmarks", "foundation-baseline.json");
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const check = process.argv.includes("--check");
const reportArgument = process.argv.indexOf("--report");
const reportPath =
  reportArgument < 0
    ? undefined
    : path.resolve(
        repositoryRoot,
        process.argv[reportArgument + 1] ?? "benchmark-results/foundation.json"
      );

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function percentile(sorted, ratio) {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

async function measureIterations(iterations, action) {
  const durations = [];
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const iterationStartedAt = performance.now();
    await action(index);
    durations.push(performance.now() - iterationStartedAt);
  }
  const totalMs = performance.now() - startedAt;
  const sorted = durations.toSorted((left, right) => left - right);
  return {
    iterations,
    totalMs: round(totalMs),
    meanMs: round(totalMs / iterations),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1))
  };
}

function host() {
  let commit = 0;
  return {
    hostKind: "desktop",
    supportedRuntimes: ["in-process"],
    environment: {
      operatingSystem: process.platform,
      architecture: process.arch
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
    createCommitId: () => `commit_benchmark_${++commit}`
  };
}

function evaluationRequest(index, iterations) {
  const denominator = Math.max(1, iterations - 1);
  return {
    documentId: "document_main",
    time: timeValue(rational(index * 5, denominator), STANDARD_TIME_DOMAINS.seconds),
    mode: "deterministic",
    viewport: { width: 1280, height: 720, pixelRatio: rational(1) },
    colorSpace: STANDARD_COLOR_SPACES.srgb,
    locale: "en-US",
    randomSeed: `foundation-benchmark-${index}`,
    externalSignals: { title: "CI foundation benchmark" }
  };
}

function authoringProposal(index) {
  const keyframeId = "keyframe_benchmark_authoring";
  const target = ["kw://project/document/document_main"];
  const seconds = (numerator, denominator = 1) =>
    serializedTime(timeValue(rational(numerator, denominator), STANDARD_TIME_DOMAINS.seconds));
  return {
    transactionId: `transaction_benchmark_authoring_${index}`,
    branchName: "main",
    origin: { kind: "user" },
    operations: [
      {
        operationId: `operation_benchmark_upsert_${index}`,
        operationType: STANDARD_MOTION_OPERATIONS.upsertKeyframe,
        schemaVersion: 1,
        targets: target,
        payload: {
          documentId: "document_main",
          trackId: "track_orbit_opacity",
          keyframe: {
            keyframeId,
            time: seconds(1),
            value: ((index % 20) + 1) / 25,
            easing: { kind: STANDARD_KEYFRAME_EASINGS.linear }
          }
        }
      },
      {
        operationId: `operation_benchmark_move_${index}`,
        operationType: STANDARD_MOTION_OPERATIONS.moveKeyframe,
        schemaVersion: 1,
        targets: target,
        payload: {
          documentId: "document_main",
          trackId: "track_orbit_opacity",
          keyframeId,
          time: seconds(2)
        }
      }
    ]
  };
}

function assertWorkload() {
  const expected = {
    project: "examples/golden/animated-signals",
    warmupIterations: 8,
    evaluationIterations: 120,
    svgRenderIterations: 120,
    authoringTransactionIterations: 80
  };
  if (canonicalStringify(baseline.workload) !== canonicalStringify(expected)) {
    throw new Error("Foundation benchmark workload and baseline metadata disagree");
  }
}

assertWorkload();
const projectRoot = path.join(repositoryRoot, baseline.workload.project);
const repository = new NodeProjectRepository();
const readStartedAt = performance.now();
const project = await repository.read(projectRoot);
const repositoryReadMs = round(performance.now() - readStartedAt);
if (project.snapshot === undefined) {
  throw new Error(`Benchmark project did not open:\n${canonicalStringify(project.diagnostics)}`);
}

const sessionStartedAt = performance.now();
const opened = await ProjectSession.open({
  kineweaveVersion: KINEWEAVE_VERSION,
  bundle: project.snapshot.bundle,
  distribution: createOfficialDistributionProfile(),
  host: host()
});
const sessionOpenMs = round(performance.now() - sessionStartedAt);
if (opened.session === undefined) {
  throw new Error(`Benchmark session did not open:\n${canonicalStringify(opened.diagnostics)}`);
}

const session = opened.session;
let svgBytes = 0;
let evaluation;
let metrics;
try {
  const representativeRequest = evaluationRequest(
    Math.floor(baseline.workload.evaluationIterations / 2),
    baseline.workload.evaluationIterations
  );
  for (let index = 0; index < baseline.workload.warmupIterations; index += 1) {
    evaluation = await session.evaluate(representativeRequest);
    await session.renderOutput({
      graph: evaluation.graph,
      evaluationMode: "deterministic",
      target: "org.kineweave.output/svg"
    });
  }

  const evaluationMetrics = await measureIterations(
    baseline.workload.evaluationIterations,
    async (index) => {
      evaluation = await session.evaluate(
        evaluationRequest(index, baseline.workload.evaluationIterations)
      );
    }
  );
  evaluation ??= await session.evaluate(representativeRequest);
  const svgRenderMetrics = await measureIterations(
    baseline.workload.svgRenderIterations,
    async () => {
      const rendered = await session.renderOutput({
        graph: evaluation.graph,
        evaluationMode: "deterministic",
        target: "org.kineweave.output/svg"
      });
      if (rendered.artifact.kind !== "text") {
        throw new Error("Foundation benchmark expected a text SVG artifact");
      }
      svgBytes = Buffer.byteLength(rendered.artifact.text, "utf8");
    }
  );
  const authoringTransactionMetrics = await measureIterations(
    baseline.workload.authoringTransactionIterations,
    async (index) => {
      await session.execute(authoringProposal(index));
    }
  );
  metrics = {
    repositoryReadMs,
    sessionOpenMs,
    evaluation: evaluationMetrics,
    svgRender: svgRenderMetrics,
    authoringTransaction: authoringTransactionMetrics,
    svgBytes
  };
} finally {
  await session.dispose();
}

const report = {
  schemaVersion: 1,
  workload: baseline.workload,
  reference: baseline.reference,
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    ci: process.env.CI === "true"
  },
  metrics,
  budgets: baseline.budgets
};

if (reportPath !== undefined) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (check) {
  const failures = [];
  const compare = (label, actual, budget) => {
    if (actual > budget) failures.push(`${label}: ${actual}ms > ${budget}ms`);
  };
  compare("repository read", metrics.repositoryReadMs, baseline.budgets.repositoryReadMs);
  compare("session open", metrics.sessionOpenMs, baseline.budgets.sessionOpenMs);
  compare("evaluation total", metrics.evaluation.totalMs, baseline.budgets.evaluationTotalMs);
  compare("evaluation p95", metrics.evaluation.p95Ms, baseline.budgets.evaluationP95Ms);
  compare("evaluation max", metrics.evaluation.maxMs, baseline.budgets.evaluationMaxMs);
  compare("SVG render total", metrics.svgRender.totalMs, baseline.budgets.svgRenderTotalMs);
  compare("SVG render p95", metrics.svgRender.p95Ms, baseline.budgets.svgRenderP95Ms);
  compare("SVG render max", metrics.svgRender.maxMs, baseline.budgets.svgRenderMaxMs);
  compare(
    "authoring transaction total",
    metrics.authoringTransaction.totalMs,
    baseline.budgets.authoringTransactionTotalMs
  );
  compare(
    "authoring transaction p95",
    metrics.authoringTransaction.p95Ms,
    baseline.budgets.authoringTransactionP95Ms
  );
  compare(
    "authoring transaction max",
    metrics.authoringTransaction.maxMs,
    baseline.budgets.authoringTransactionMaxMs
  );
  if (failures.length > 0) {
    throw new Error(`Foundation performance budgets exceeded:\n${failures.join("\n")}`);
  }
}
