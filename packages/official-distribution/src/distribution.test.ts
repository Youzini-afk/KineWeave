import { describe, expect, it } from "vitest";
import { createEsmExtensionSource } from "@kineweave/extension-host";
import { ProjectSession } from "@kineweave/project-session";
import {
  STANDARD_COLOR_SPACES,
  STANDARD_TIME_DOMAINS,
  createProjectResourceUri,
  rational,
  timeValue,
  type JsonObject,
  type ExtensionManifest,
  type TransactionProposal
} from "@kineweave/protocol";
import {
  STANDARD_MOTION_OPERATIONS,
  constant
} from "@kineweave/standard-motion-document";
import {
  KINEWEAVE_VERSION,
  createOfficialDistributionProfile
} from "./distribution.js";
import { createOfficialProjectTemplate } from "./template.js";

function host() {
  let commit = 0;
  return {
    hostKind: "cli" as const,
    supportedRuntimes: ["in-process" as const],
    environment: { operatingSystem: "test", architecture: "test" },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
    createCommitId: () => `commit_test_${++commit}`
  };
}

function evaluationRequest(branchName?: string) {
  return {
    documentId: "document_main",
    ...(branchName === undefined
      ? {}
      : { state: { kind: "branch" as const, branchName } }),
    time: timeValue(rational(1, 2), STANDARD_TIME_DOMAINS.seconds),
    mode: "deterministic" as const,
    viewport: { width: 1920, height: 1080, pixelRatio: rational(1) },
    colorSpace: STANDARD_COLOR_SPACES.srgb,
    locale: "en-US",
    randomSeed: "official-distribution-test",
    externalSignals: {}
  };
}

describe("official distribution", () => {
  it("loads official ESM entrypoints and shares one session across history, evaluation and rendering", async () => {
    const bundle = createOfficialProjectTemplate({
      name: "Session Test",
      projectId: "project_session_test"
    });
    const opened = await ProjectSession.open({
      kineweaveVersion: KINEWEAVE_VERSION,
      bundle,
      distribution: createOfficialDistributionProfile(),
      host: host()
    });
    expect(opened.diagnostics).toEqual([]);
    const session = opened.session!;

    const mainEvaluation = await session.evaluate(evaluationRequest());
    expect(mainEvaluation.graph.nodes.node_headline?.data.text).toBe(
      "Hello KineWeave"
    );
    const rendered = await session.render({
      graph: mainEvaluation.graph,
      evaluationMode: "deterministic"
    });
    expect(rendered.provider.providerId).toBe("org.kineweave.renderer/svg");
    expect(rendered.artifact.text).toContain("Hello KineWeave");

    session.createBranch("proposal/alternate");
    const proposal: TransactionProposal = {
      transactionId: "transaction_branch_edit",
      branchName: "proposal/alternate",
      origin: { kind: "user", actorId: "test" },
      operations: [
        {
          operationId: "operation_branch_edit",
          operationType: STANDARD_MOTION_OPERATIONS.setProperty,
          schemaVersion: 1,
          targets: [
            createProjectResourceUri("document", "document_main", [
              "node",
              "node_headline"
            ])
          ],
          payload: {
            documentId: "document_main",
            nodeId: "node_headline",
            property: "content",
            binding: constant("Branch Version")
          }
        }
      ]
    };
    await session.execute(proposal);
    const branchEvaluation = await session.evaluate(
      evaluationRequest("proposal/alternate")
    );
    expect(branchEvaluation.graph.nodes.node_headline?.data.text).toBe(
      "Branch Version"
    );
    expect((await session.evaluate(evaluationRequest())).graph.nodes.node_headline?.data.text).toBe(
      "Hello KineWeave"
    );
    const persistedMain = session.toBundle().documents.document_main as unknown as {
      data: JsonObject;
    };
    expect(
      (persistedMain.data.nodes as JsonObject).node_headline
    ).toMatchObject({
      properties: { content: constant("Hello KineWeave") }
    });

    await session.dispose();
    expect(session.extensions.statuses().every((status) => status.state === "deactivated")).toBe(
      true
    );
  });

  it("rejects and rolls back an extension whose registrations do not match its manifest", async () => {
    const badManifest: ExtensionManifest = {
      manifestVersion: 1,
      extensionId: "org.example.incomplete",
      version: "1.0.0",
      kineweaveVersion: "^0.1.0",
      apiStability: "experimental",
      dependencies: {},
      entrypoints: [
        {
          runtime: "in-process",
          module: "./dist/index.js",
          exportName: "activate"
        }
      ],
      contributes: {
        operationTypes: [
          { operationType: "org.example.incomplete/change", schemaVersions: [1] }
        ]
      }
    };
    let deactivationCount = 0;
    const badSource = createEsmExtensionSource({
      manifest: badManifest,
      importEntrypoint: async () => ({
        activate: () => ({
          deactivate: () => {
            deactivationCount += 1;
          }
        })
      })
    });
    const baseBundle = createOfficialProjectTemplate({
      name: "Contribution Audit",
      projectId: "project_contribution_audit"
    });
    const bundle = {
      ...baseBundle,
      manifest: {
        ...baseBundle.manifest,
        extensionRequirements: {
          ...baseBundle.manifest.extensionRequirements,
          [badManifest.extensionId]: {
            versionRange: "1.0.0",
            source: { kind: "package" as const, packageName: "@example/incomplete" }
          }
        }
      },
      lockfile: {
        ...baseBundle.lockfile,
        extensions: {
          ...baseBundle.lockfile.extensions,
          [badManifest.extensionId]: {
            version: "1.0.0",
            source: { kind: "package", packageName: "@example/incomplete" }
          }
        }
      }
    };
    const official = createOfficialDistributionProfile();
    const opened = await ProjectSession.open({
      kineweaveVersion: KINEWEAVE_VERSION,
      bundle,
      distribution: {
        ...official,
        extensions: [...official.extensions, badSource]
      },
      host: host()
    });

    expect(opened.session).toBeUndefined();
    expect(opened.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "extension.contribution.missing" })
      ])
    );
    expect(deactivationCount).toBe(1);
  });
});
