import type { CapabilityProviderDescriptor, CapabilityRequirement } from "@kineweave/protocol";
import { describe, expect, it } from "vitest";
import { resolveCapabilityPlan } from "./resolver.js";

const renderRequirement: CapabilityRequirement = {
  capabilityId: "kineweave.renderer.2d",
  contractVersion: "^1.0.0",
  requiredFeatures: ["kineweave.renderer.feature/alpha"]
};

function provider(overrides: Partial<CapabilityProviderDescriptor>): CapabilityProviderDescriptor {
  return {
    capabilityId: "kineweave.renderer.2d",
    providerId: "org.kineweave.renderer/canvas",
    extensionId: "org.kineweave.renderer-canvas",
    contractVersion: "1.0.0",
    implementationVersion: "1.0.0",
    features: ["kineweave.renderer.feature/alpha"],
    lifetime: "project",
    ...overrides
  };
}

describe("capability resolution", () => {
  it("creates a deterministic dependency-first activation plan", () => {
    const codec = provider({
      capabilityId: "kineweave.codec.video",
      providerId: "org.example.codec/h264",
      extensionId: "org.example.codec",
      features: [],
      lifetime: "singleton"
    });
    const renderer = provider({
      requires: [
        {
          capabilityId: "kineweave.codec.video",
          contractVersion: "^1.0.0"
        }
      ]
    });
    const plan = resolveCapabilityPlan({
      requirements: [renderRequirement],
      providers: [renderer, codec],
      environment: { hostKind: "desktop", evaluationMode: "interactive" }
    });

    expect(plan.diagnostics).toEqual([]);
    expect(plan.activationOrder.map((item) => item.providerId)).toEqual([
      "org.example.codec/h264",
      "org.kineweave.renderer/canvas"
    ]);
  });

  it("uses lockfile bindings strictly instead of silently choosing another provider", () => {
    const canvas = provider({});
    const dom = provider({
      providerId: "org.kineweave.renderer/dom",
      extensionId: "org.kineweave.renderer-dom",
      implementationVersion: "1.1.0"
    });
    const plan = resolveCapabilityPlan({
      requirements: [renderRequirement],
      providers: [canvas, dom],
      environment: { hostKind: "desktop" },
      lockedBindings: {
        "kineweave.renderer.2d": {
          defaultProviderId: "org.kineweave.renderer/dom",
          providers: {
            "org.kineweave.renderer/dom": {
              providerId: "org.kineweave.renderer/dom",
              contractVersion: "1.0.0",
              implementationVersion: "9.9.9",
              features: ["kineweave.renderer.feature/alpha"]
            }
          }
        }
      }
    });

    expect(plan.diagnostics).toEqual([
      expect.objectContaining({ code: "capability.lockfile.unavailable" })
    ]);
    expect(plan.bindings).toEqual({});
  });

  it("rejects a locked provider that no longer satisfies required features", () => {
    const canvas = provider({ features: [] });
    const plan = resolveCapabilityPlan({
      requirements: [renderRequirement],
      providers: [canvas],
      environment: { hostKind: "desktop" },
      lockedBindings: {
        "kineweave.renderer.2d": {
          defaultProviderId: canvas.providerId,
          providers: {
            [canvas.providerId]: {
              providerId: canvas.providerId,
              contractVersion: canvas.contractVersion,
              implementationVersion: canvas.implementationVersion,
              features: []
            }
          }
        }
      }
    });

    expect(plan.diagnostics).toEqual([
      expect.objectContaining({ code: "capability.lockfile.unavailable" })
    ]);
  });

  it("falls back when a preferred provider cannot satisfy its dependencies", () => {
    const preferred = provider({
      providerId: "org.example.renderer/gpu",
      extensionId: "org.example.renderer",
      priority: 100,
      requires: [
        {
          capabilityId: "org.example.gpu/device",
          contractVersion: "^1.0.0"
        }
      ]
    });
    const canvas = provider({ priority: 1 });
    const plan = resolveCapabilityPlan({
      requirements: [
        {
          ...renderRequirement,
          preferredProviderIds: ["org.example.renderer/gpu"]
        }
      ],
      providers: [preferred, canvas],
      environment: { hostKind: "desktop" }
    });

    expect(plan.diagnostics).toEqual([]);
    expect(plan.bindings["kineweave.renderer.2d"]?.descriptor.providerId).toBe(
      "org.kineweave.renderer/canvas"
    );
  });

  it("filters providers by host and evaluation mode", () => {
    const liveOnly = provider({
      providerId: "org.example.renderer/live",
      extensionId: "org.example.renderer",
      priority: 100,
      environment: {
        hostKinds: ["desktop"],
        evaluationModes: ["live"]
      }
    });
    const deterministic = provider({ priority: 1 });
    const plan = resolveCapabilityPlan({
      requirements: [renderRequirement],
      providers: [liveOnly, deterministic],
      environment: {
        hostKind: "render-node",
        evaluationMode: "deterministic"
      }
    });

    expect(plan.bindings["kineweave.renderer.2d"]?.descriptor.providerId).toBe(
      "org.kineweave.renderer/canvas"
    );
  });

  it("backtracks across top-level requirements to find a globally valid plan", () => {
    const rendererCapability = "org.example.renderer/presentation";
    const deviceCapability = "org.example.device/runtime";
    const legacyRenderer = provider({
      capabilityId: rendererCapability,
      providerId: "org.example.renderer/legacy",
      extensionId: "org.example.renderer-legacy",
      features: [],
      priority: 100,
      requires: [{ capabilityId: deviceCapability, contractVersion: "^1.0.0" }]
    });
    const modernRenderer = provider({
      capabilityId: rendererCapability,
      providerId: "org.example.renderer/modern",
      extensionId: "org.example.renderer-modern",
      features: [],
      priority: 1,
      requires: [{ capabilityId: deviceCapability, contractVersion: "^2.0.0" }]
    });
    const deviceV1 = provider({
      capabilityId: deviceCapability,
      providerId: "org.example.device/v1",
      extensionId: "org.example.device-v1",
      contractVersion: "1.0.0",
      features: []
    });
    const deviceV2 = provider({
      capabilityId: deviceCapability,
      providerId: "org.example.device/v2",
      extensionId: "org.example.device-v2",
      contractVersion: "2.0.0",
      features: []
    });

    const plan = resolveCapabilityPlan({
      requirements: [
        { capabilityId: rendererCapability, contractVersion: "^1.0.0" },
        { capabilityId: deviceCapability, contractVersion: "^2.0.0" }
      ],
      providers: [legacyRenderer, modernRenderer, deviceV1, deviceV2],
      environment: { hostKind: "desktop" }
    });

    expect(plan.diagnostics).toEqual([]);
    expect(plan.bindings[rendererCapability]?.descriptor.providerId).toBe(
      modernRenderer.providerId
    );
    expect(plan.bindings[deviceCapability]?.descriptor.providerId).toBe(deviceV2.providerId);
  });

  it("rejects provider dependency cycles before activation planning", () => {
    const capabilityA = "org.example.capability/a";
    const capabilityB = "org.example.capability/b";
    const providerA = provider({
      capabilityId: capabilityA,
      providerId: "org.example.provider/a",
      extensionId: "org.example.provider-a",
      features: [],
      requires: [{ capabilityId: capabilityB, contractVersion: "^1.0.0" }]
    });
    const providerB = provider({
      capabilityId: capabilityB,
      providerId: "org.example.provider/b",
      extensionId: "org.example.provider-b",
      features: [],
      requires: [{ capabilityId: capabilityA, contractVersion: "^1.0.0" }]
    });

    const plan = resolveCapabilityPlan({
      requirements: [{ capabilityId: capabilityA, contractVersion: "^1.0.0" }],
      providers: [providerA, providerB],
      environment: { hostKind: "desktop" }
    });

    expect(plan.bindings).toEqual({});
    expect(plan.diagnostics).toEqual([
      expect.objectContaining({ code: "capability.dependency.cycle" })
    ]);
  });
});
