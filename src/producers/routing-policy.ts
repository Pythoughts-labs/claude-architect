import type { CapabilityReport } from "./producer-adapter.js";

export interface RoutingCandidate {
  producerId: string;
  outcome: "selected" | "unknown-producer" | "authentication-required" | "ineligible";
  detail: string | null;
}

export type RoutingResult =
  | { producerId: string; considered: RoutingCandidate[] }
  | {
    producerId: null;
    reason: "authentication-required" | "no-eligible-producer";
    considered: RoutingCandidate[];
  };

export function route(
  preferences: string[],
  reports: CapabilityReport[],
): RoutingResult {
  const considered: RoutingCandidate[] = [];
  for (const producerId of preferences) {
    const report = reports.find(candidate => candidate.producerId === producerId);
    if (report === undefined) {
      considered.push({ producerId, outcome: "unknown-producer", detail: null });
      continue;
    }
    if (report.reason === "authentication-required") {
      considered.push({ producerId, outcome: "authentication-required", detail: report.reason });
      return { producerId: null, reason: "authentication-required", considered };
    }
    // Write-confinement enforcement (and its specific diagnostics) is owned by
    // the attempt runtime's edit-mode gate; routing only screens out producers
    // that are unavailable, have no resolved executable, or are edit-ineligible.
    let ineligibleDetail: string | null = null;
    if (report.available !== true) {
      ineligibleDetail = report.reason ?? "available=false";
    } else if (report.resolvedExecutable === null) {
      ineligibleDetail = "resolvedExecutable=null";
    } else if (report.laneEligibility.edit !== true) {
      ineligibleDetail = report.reason ?? "laneEligibility.edit=false";
    }
    if (ineligibleDetail !== null) {
      considered.push({ producerId, outcome: "ineligible", detail: ineligibleDetail });
      continue;
    }
    considered.push({ producerId, outcome: "selected", detail: null });
    return { producerId, considered };
  }

  return { producerId: null, reason: "no-eligible-producer", considered };
}
