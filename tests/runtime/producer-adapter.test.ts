import { describe, expect, it } from "vitest";
import type { PlatformServices, ResolvedExecutable } from "../../src/platform/platform-services.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import {
  detectEnvironmentType,
  type CapabilityReport,
  type InvocationContext,
  type ProbeContext,
  type ProducerAdapter,
  type ProducerConfigurationProfile,
  type ProducerInvocation,
} from "../../src/producers/producer-adapter.js";

const executable: ResolvedExecutable = {
  kind: "native",
  command: "/usr/local/bin/fake",
  prefixArgs: [],
  resolvedFrom: "test",
};

class FakeAdapter implements ProducerAdapter {
  readonly producerId = "fake";

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    return {
      producerId: this.producerId,
      available: true,
      reason: null,
      os: ctx.os,
      arch: ctx.arch,
      environmentType: ctx.environmentType,
      resolvedExecutable: executable,
      version: "1.0.0",
      authState: "unknown",
      executionModes: ["edit"],
      structuredOutput: true,
      writeConfinementBackend: "fake-sandbox",
      laneEligibility: { edit: true },
    };
  }

  buildInvocation(_spec: DelegationSpec, ctx: InvocationContext): ProducerInvocation {
    return {
      executable: ctx.executable,
      args: [],
      requiredEnv: [],
      network: "denied",
    };
  }

  normalizeEvents(
    _raw: Parameters<ProducerAdapter["normalizeEvents"]>[0],
  ): ReturnType<ProducerAdapter["normalizeEvents"]> {
    return { events: [], producerSummary: null, ok: true };
  }

  configurationProfile(): ProducerConfigurationProfile {
    return {
      isolationState: "controlled-config-supported",
      credentialSources: [],
      behavioralConfigSources: [],
      repositoryInstructionSources: [],
      environmentDependencies: [],
      temporaryHomeStrategy: "none",
    };
  }
}

describe("ProducerAdapter", () => {
  it("detects the certified macOS host as a native environment", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    try {
      expect(detectEnvironmentType()).toBe("native");
    } finally {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("supports a shared adapter contract with boolean edit eligibility", async () => {
    const adapter: ProducerAdapter = new FakeAdapter();
    const report = await adapter.probe({
      ps: {} as PlatformServices,
      os: "darwin",
      arch: "arm64",
      environmentType: "native",
    });

    expect(report.laneEligibility.edit).toBe(true);
  });
});
