import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HistoryGraph } from "@kineweave/history-engine";
import {
  createOfficialDistributionProfile,
  createOfficialProjectTemplate,
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
  constant,
  createExternalSignal,
  createGroupNode,
  cubicBezierEasing,
  STANDARD_KEYFRAME_EASINGS,
  STANDARD_VALUE_TYPES,
  serializedTime
} from "@kineweave/standard-motion-document";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const goldenRoot = path.join(repositoryRoot, "examples", "golden");
const update = process.argv.includes("--update");
const repository = new NodeProjectRepository();

function composition(bundle) {
  return structuredClone(bundle.documents.document_main);
}

function finalize(bundle, document) {
  bundle.documents.document_main = document;
  bundle.history = new HistoryGraph({ document_main: document }).toSnapshot();
  return bundle;
}

function keyframe(keyframeId, seconds, value, easing) {
  return {
    keyframeId,
    time: serializedTime(
      timeValue(rational(Math.round(seconds * 1000), 1000), STANDARD_TIME_DOMAINS.seconds)
    ),
    value,
    ...(easing === undefined ? {} : { easing })
  };
}

function coreStaticScene() {
  const bundle = createOfficialProjectTemplate({
    name: "Golden · Core Static Scene",
    projectId: "project_golden_core_static"
  });
  const document = composition(bundle);
  const scene = document.data.nodes.node_scene;
  scene.properties.position = constant([72, -36]);
  scene.properties.scale = constant([0.92, 0.92]);
  scene.properties.rotation = constant(2.5);
  scene.properties.anchor = constant([960, 540]);
  scene.properties.opacity = constant(0.88);
  document.data.nodes.node_headline.properties.content = constant('Kine <Weave> & "deterministic"');
  document.data.nodes.node_headline.properties.anchor = constant([0, 24]);
  document.data.nodes.node_mark.properties.stroke = constant("#dfe5ff");
  document.data.nodes.node_mark.properties.strokeWidth = constant(6);
  return finalize(bundle, document);
}

function animatedSignalsScene() {
  const bundle = createOfficialProjectTemplate({
    name: "Golden · Animated Signals",
    projectId: "project_golden_animated_signals"
  });
  const document = composition(bundle);
  const panel = document.data.nodes.node_panel;
  const orbit = document.data.nodes.node_orbit;
  const headline = document.data.nodes.node_headline;
  const mark = document.data.nodes.node_mark;

  panel.properties.position = { kind: "track", trackId: "track_panel_position" };
  orbit.properties.opacity = { kind: "track", trackId: "track_orbit_opacity" };
  mark.properties.fill = { kind: "track", trackId: "track_mark_fill" };
  mark.properties.visible = { kind: "track", trackId: "track_mark_visible" };
  headline.properties.content = { kind: "signal", signalId: "signal_title" };

  document.data.tracks.track_panel_position = {
    trackId: "track_panel_position",
    valueType: STANDARD_VALUE_TYPES.vector2,
    target: { nodeId: panel.nodeId, property: "position" },
    keyframes: {
      keyframe_panel_start: keyframe(
        "keyframe_panel_start",
        0,
        [640, 540],
        cubicBezierEasing(0.42, 0, 0.58, 1)
      ),
      keyframe_panel_end: keyframe("keyframe_panel_end", 5, [1280, 540], {
        kind: STANDARD_KEYFRAME_EASINGS.linear
      })
    }
  };
  document.data.tracks.track_orbit_opacity = {
    trackId: "track_orbit_opacity",
    valueType: STANDARD_VALUE_TYPES.number,
    target: { nodeId: orbit.nodeId, property: "opacity" },
    keyframes: {
      keyframe_orbit_start: keyframe("keyframe_orbit_start", 0, 0.15, {
        kind: STANDARD_KEYFRAME_EASINGS.hold
      }),
      keyframe_orbit_middle: keyframe("keyframe_orbit_middle", 2.5, 0.9, {
        kind: STANDARD_KEYFRAME_EASINGS.linear
      }),
      keyframe_orbit_end: keyframe("keyframe_orbit_end", 5, 0.35)
    }
  };
  document.data.tracks.track_mark_fill = {
    trackId: "track_mark_fill",
    valueType: STANDARD_VALUE_TYPES.color,
    target: { nodeId: mark.nodeId, property: "fill" },
    keyframes: {
      keyframe_fill_start: keyframe("keyframe_fill_start", 0, "#ff4060", {
        kind: STANDARD_KEYFRAME_EASINGS.linear
      }),
      keyframe_fill_end: keyframe("keyframe_fill_end", 5, "#40d9ff")
    }
  };
  document.data.tracks.track_mark_visible = {
    trackId: "track_mark_visible",
    valueType: STANDARD_VALUE_TYPES.boolean,
    target: { nodeId: mark.nodeId, property: "visible" },
    keyframes: {
      keyframe_visible_start: keyframe("keyframe_visible_start", 0, true, {
        kind: STANDARD_KEYFRAME_EASINGS.hold
      }),
      keyframe_visible_end: keyframe("keyframe_visible_end", 4, false)
    }
  };
  document.data.signals.signal_title = createExternalSignal(
    "signal_title",
    "title",
    STANDARD_VALUE_TYPES.string,
    "Signal default"
  );
  return finalize(bundle, document);
}

function transformsVisibilityScene() {
  const bundle = createOfficialProjectTemplate({
    name: "Golden · Transforms & Visibility",
    projectId: "project_golden_transforms_visibility"
  });
  const document = composition(bundle);
  const scene = document.data.nodes.node_scene;
  const cluster = createGroupNode("node_cluster", "Nested Cluster");
  cluster.children.push("node_orbit", "node_mark", "node_headline");
  cluster.properties.position = constant([180, 120]);
  cluster.properties.scale = constant([0.72, 1.15]);
  cluster.properties.rotation = constant(-18);
  cluster.properties.anchor = constant([960, 540]);
  cluster.properties.opacity = constant(0.64);
  document.data.nodes[cluster.nodeId] = cluster;
  scene.children.splice(1, 3, cluster.nodeId);
  scene.properties.position = constant([-90, 45]);
  scene.properties.rotation = constant(7);
  document.data.nodes.node_panel.properties.visible = constant(false);
  document.data.nodes.node_orbit.properties.opacity = constant(0);
  document.data.nodes.node_mark.properties.scale = constant([1.4, 0.8]);
  document.data.nodes.node_mark.properties.anchor = constant([12, -8]);
  document.data.nodes.node_headline.properties.opacity = constant(0.55);
  return finalize(bundle, document);
}

function motionAuthoringScene() {
  const bundle = createOfficialProjectTemplate({
    name: "Golden · Motion Authoring",
    projectId: "project_golden_motion_authoring"
  });
  const document = composition(bundle);
  const panel = document.data.nodes.node_panel;
  const headline = document.data.nodes.node_headline;

  headline.properties.content = constant("Motion authoring");
  headline.properties.position = { kind: "track", trackId: "track_headline_position" };
  headline.properties.rotation = { kind: "track", trackId: "track_headline_rotation" };
  panel.properties.scale = { kind: "track", trackId: "track_panel_scale" };

  document.data.tracks.track_headline_position = {
    trackId: "track_headline_position",
    valueType: STANDARD_VALUE_TYPES.vector2,
    target: { nodeId: headline.nodeId, property: "position" },
    keyframes: {
      keyframe_position_start: keyframe(
        "keyframe_position_start",
        0,
        [720, 620],
        cubicBezierEasing(0.42, 0, 0.58, 1)
      ),
      keyframe_position_middle: keyframe(
        "keyframe_position_middle",
        2,
        [960, 400],
        cubicBezierEasing(0, 0, 0.58, 1)
      ),
      keyframe_position_end: keyframe("keyframe_position_end", 5, [1240, 620])
    }
  };
  document.data.tracks.track_headline_rotation = {
    trackId: "track_headline_rotation",
    valueType: STANDARD_VALUE_TYPES.number,
    target: { nodeId: headline.nodeId, property: "rotation" },
    keyframes: {
      keyframe_rotation_start: keyframe("keyframe_rotation_start", 0, -8, {
        kind: STANDARD_KEYFRAME_EASINGS.linear
      }),
      keyframe_rotation_middle: keyframe(
        "keyframe_rotation_middle",
        2,
        12,
        cubicBezierEasing(0.42, 0, 1, 1)
      ),
      keyframe_rotation_end: keyframe("keyframe_rotation_end", 5, 0)
    }
  };
  document.data.tracks.track_panel_scale = {
    trackId: "track_panel_scale",
    valueType: STANDARD_VALUE_TYPES.vector2,
    target: { nodeId: panel.nodeId, property: "scale" },
    keyframes: {
      keyframe_scale_start: keyframe(
        "keyframe_scale_start",
        0,
        [0.82, 0.82],
        cubicBezierEasing(0.42, 0, 0.58, 1)
      ),
      keyframe_scale_end: keyframe("keyframe_scale_end", 5, [1.08, 0.94])
    }
  };
  return finalize(bundle, document);
}

const fixtures = [
  {
    directory: "core-static-scene",
    bundle: coreStaticScene(),
    samples: [{ name: "t0000", seconds: 0, externalSignals: {} }]
  },
  {
    directory: "animated-signals",
    bundle: animatedSignalsScene(),
    samples: [
      { name: "t0000-default", seconds: 0, externalSignals: {} },
      {
        name: "t2500-external",
        seconds: 2.5,
        externalSignals: { title: "External <title> at 2.5s" }
      },
      { name: "t5000-default", seconds: 5, externalSignals: {} }
    ]
  },
  {
    directory: "transforms-visibility",
    bundle: transformsVisibilityScene(),
    samples: [{ name: "t0000", seconds: 0, externalSignals: {} }]
  },
  {
    directory: "motion-authoring",
    bundle: motionAuthoringScene(),
    samples: [
      { name: "t0000", seconds: 0, externalSignals: {} },
      { name: "t2000", seconds: 2, externalSignals: {} },
      { name: "t3500", seconds: 3.5, externalSignals: {} },
      { name: "t5000", seconds: 5, externalSignals: {} }
    ]
  }
];

function sessionHost() {
  let commit = 0;
  return {
    hostKind: "desktop",
    supportedRuntimes: ["in-process"],
    environment: { operatingSystem: "golden", architecture: "deterministic" },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
    createCommitId: () => `commit_golden_${++commit}`
  };
}

async function expectedOutputs(fixture) {
  const opened = await ProjectSession.open({
    kineweaveVersion: KINEWEAVE_VERSION,
    bundle: structuredClone(fixture.bundle),
    distribution: createOfficialDistributionProfile(),
    host: sessionHost()
  });
  if (opened.session === undefined) {
    throw new Error(
      `Golden project ${fixture.directory} did not open:\n${canonicalStringify(opened.diagnostics)}`
    );
  }
  const session = opened.session;
  const profile = fixture.bundle.manifest.outputProfiles.svg;
  const outputs = new Map();
  try {
    for (const sample of fixture.samples) {
      const evaluation = await session.evaluate({
        documentId: "document_main",
        time: timeValue(
          rational(Math.round(sample.seconds * 1000), 1000),
          STANDARD_TIME_DOMAINS.seconds
        ),
        mode: "deterministic",
        viewport: { width: 1280, height: 720, pixelRatio: rational(1) },
        colorSpace: STANDARD_COLOR_SPACES.srgb,
        locale: "en-US",
        randomSeed: `golden:${fixture.directory}:${sample.name}`,
        externalSignals: sample.externalSignals
      });
      const rendered = await session.renderOutput({
        graph: evaluation.graph,
        evaluationMode: "deterministic",
        target: profile.target,
        ...(profile.requiredFeatures === undefined
          ? {}
          : { requiredFeatures: profile.requiredFeatures })
      });
      if (rendered.artifact.kind !== "text") {
        throw new Error(`Golden SVG output for ${fixture.directory}/${sample.name} was not text`);
      }
      outputs.set(`${sample.name}.graph.json`, canonicalStringify(evaluation.graph));
      outputs.set(`${sample.name}.svg`, rendered.artifact.text);
    }
  } finally {
    await session.dispose();
  }
  return outputs;
}

async function readText(filePath) {
  return readFile(filePath, "utf8").catch(() => undefined);
}

const stale = [];
for (const fixture of fixtures) {
  const target = path.resolve(goldenRoot, fixture.directory);
  if (path.dirname(target) !== goldenRoot) {
    throw new Error(`Refusing to generate outside ${goldenRoot}: ${target}`);
  }
  const outputs = await expectedOutputs(fixture);
  if (update) {
    await rm(target, { recursive: true, force: true });
    await repository.initialize(target, fixture.bundle);
    const expectedDirectory = path.join(target, "expected");
    await mkdir(expectedDirectory, { recursive: true });
    for (const [name, content] of outputs) {
      await writeFile(path.join(expectedDirectory, name), content, "utf8");
    }
    continue;
  }

  const persisted = await repository.read(target);
  if (
    persisted.snapshot === undefined ||
    canonicalStringify(persisted.snapshot.bundle) !== canonicalStringify(fixture.bundle)
  ) {
    stale.push(`${fixture.directory}: project files`);
  }
  for (const [name, content] of outputs) {
    if ((await readText(path.join(target, "expected", name))) !== content) {
      stale.push(`${fixture.directory}: expected/${name}`);
    }
  }
}

if (stale.length > 0) {
  throw new Error(
    `Golden projects are stale:\n${stale.map((entry) => `- ${entry}`).join("\n")}\nRun pnpm generate:goldens.`
  );
}

const sampleCount = fixtures.reduce((count, fixture) => count + fixture.samples.length, 0);
process.stdout.write(
  `${update ? "Updated" : "Verified"} ${fixtures.length} Golden Projects (${sampleCount} samples).\n`
);
