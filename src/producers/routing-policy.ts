import type { CapabilityReport } from "./producer-adapter.js";

export type RoutingResult =
  | { producerId: string }
  | {
    producerId: null;
    reason: "authentication-required" | "no-eligible-producer";
  };

export function route(
  preferences: string[],
  reports: CapabilityReport[],
): RoutingResult {
  for (const producerId of preferences) {
    const report = reports.find(candidate => candidate.producerId === producerId);
    if (report === undefined) continue;
    if (report.reason === "authentication-required") {
      return { producerId: null, reason: "authentication-required" };
    }
    if (report.laneEligibility.edit === true) return { producerId };
  }

  return { producerId: null, reason: "no-eligible-producer" };
}
