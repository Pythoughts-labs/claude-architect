import type {
  CapabilityReport,
  ProbeContext,
} from "./producer-adapter.js";
import {
  ProducerRegistry,
  registry,
} from "./producer-registry.js";

export async function probeAll(
  ctx: ProbeContext,
  producerRegistry: ProducerRegistry = registry,
): Promise<CapabilityReport[]> {
  return Promise.all(producerRegistry.all().map(adapter => adapter.probe(ctx)));
}
