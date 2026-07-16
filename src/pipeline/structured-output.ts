import type { ValidateFunction } from "ajv";

export type ParseOutcome<T> =
  | { ok: true; value: T; repaired: boolean }
  | { ok: false; error: string };

const FENCE = /```json\s*([\s\S]*?)```/g;

export function extractJson(raw: string): string | null {
  let last: string | null = null;
  for (const match of raw.matchAll(FENCE)) last = (match[1] ?? "").trim();
  const candidate = last ?? raw.trim();
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function validateRaw<T>(raw: string, validate: ValidateFunction): { ok: true; value: T } | { ok: false; error: string } {
  const json = extractJson(raw);
  if (json === null) return { ok: false, error: "no parseable JSON in output" };
  const value = JSON.parse(json) as T;
  if (!validate(value)) {
    return { ok: false, error: JSON.stringify(validate.errors ?? []) };
  }
  return { ok: true, value };
}

/**
 * Validate producer output against a schema. On failure, invoke `repair`
 * exactly once (a fresh producer call given the validation errors); a second
 * failure is a phase failure — never a silent pass. (Fail closed.)
 */
export async function parseStructuredReport<T>(
  raw: string,
  validate: ValidateFunction,
  repair: (validationErrors: string) => Promise<string>,
): Promise<ParseOutcome<T>> {
  const first = validateRaw<T>(raw, validate);
  if (first.ok) return { ok: true, value: first.value, repaired: false };
  const repairedRaw = await repair(first.error);
  const second = validateRaw<T>(repairedRaw, validate);
  if (second.ok) return { ok: true, value: second.value, repaired: true };
  return { ok: false, error: `invalid structured output after repair: ${second.error}` };
}
