export const MINIMUM_NODE_MAJOR = 22;

export function isNodeSupported(version: string): boolean {
  const match = /^v?(\d+)(?:\.|$)/.exec(version.trim());
  return match !== null && Number(match[1]) >= MINIMUM_NODE_MAJOR;
}

export function formatMissingNodeDiagnostic(): string {
  return "Claude Architect requires Node.js 22 or newer. Install a supported Node.js release "
    + "and ensure its node executable is available on the host PATH, then reload the plugin.";
}
