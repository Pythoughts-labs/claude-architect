import { createHash } from "node:crypto";

/**
 * Identity of a Delegation Spec, reproducible by any party.
 *
 * This hash is a wire contract, not an internal detail: the runtime records it
 * at run start, and a caller compares its own spec against it to prove a
 * reported run id belongs to the spec it dispatched. Both sides must therefore
 * derive the same digest from the same spec.
 *
 * `JSON.stringify` cannot serve that purpose — it emits keys in insertion
 * order, so two structurally identical specs built in different orders hash
 * differently, and the comparison fails on correct runs while proving nothing
 * about incorrect ones. Keys are sorted at every depth; array order is
 * preserved because it is semantically meaningful (argument vectors, allowlist
 * precedence).
 */
export function canonicalSpecJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSpecJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) =>
      `${JSON.stringify(key)}:${canonicalSpecJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function specSha256(spec: unknown): string {
  return createHash("sha256").update(canonicalSpecJson(spec)).digest("hex");
}
