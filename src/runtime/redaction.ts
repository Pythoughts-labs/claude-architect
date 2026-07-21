const registeredSecrets = new Map<string, number>();
const SECRET_MARKER = "[s]";

export interface SecretRegistration {
  dispose(): void;
}

const rules: Array<{ marker: string; pattern: RegExp }> = [
  { marker: "[b]", pattern: /(?<=\bBearer[ \t]+)[A-Za-z0-9._~+/=-]+/gi },
  { marker: "[k]", pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g },
  { marker: "[g]", pattern: /\bgh[pousr]_[A-Za-z0-9]{8,}\b/g },
  { marker: "[a]", pattern: /\bAKIA[A-Z0-9]{12,}\b/g },
  { marker: "[l]", pattern: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g },
  {
    marker: "[j]",
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    marker: "[e]",
    pattern: /(?<=\b(?:(?:[A-Za-z][A-Za-z0-9]*_)*(?:TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)(?:_[A-Za-z0-9]+)*)=")[^"\r\n]+/gi,
  },
  {
    marker: "[e]",
    pattern: /(?<=\b(?:(?:[A-Za-z][A-Za-z0-9]*_)*(?:TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)(?:_[A-Za-z0-9]+)*)=')[^'\r\n]+/gi,
  },
  {
    marker: "[e]",
    pattern: /(?<=\b(?:(?:[A-Za-z][A-Za-z0-9]*_)*(?:TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)(?:_[A-Za-z0-9]+)*)=)[^\s,;"']+/gi,
  },
];

export function registerSecretValue(value: string): SecretRegistration {
  if (value.length < 6) return { dispose() {} };

  registeredSecrets.set(value, (registeredSecrets.get(value) ?? 0) + 1);
  let active = true;
  return {
    dispose(): void {
      if (!active) return;
      active = false;
      const count = registeredSecrets.get(value);
      if (count === undefined) return;
      if (count === 1) registeredSecrets.delete(value);
      else registeredSecrets.set(value, count - 1);
    },
  };
}

export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

export function containsRegisteredSecret(text: string): boolean {
  return [...registeredSecrets.keys()].some(secret => text.includes(secret));
}

export function containsRegisteredSecretValue(value: unknown): boolean {
  if (typeof value === "string") return containsRegisteredSecret(value);
  if (Array.isArray(value)) return value.some(containsRegisteredSecretValue);
  if (value === null || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(containsRegisteredSecretValue);
}

function replaceRegisteredSecrets(text: string): string {
  const secrets = [...registeredSecrets.keys()];
  if (secrets.length === 0) return text;

  let cursor = 0;
  let result = "";
  while (cursor < text.length) {
    let nextIndex = -1;
    let nextSecret = "";
    for (const secret of secrets) {
      const index = text.indexOf(secret, cursor);
      if (index < 0) continue;
      if (nextIndex < 0 || index < nextIndex || (index === nextIndex && secret.length > nextSecret.length)) {
        nextIndex = index;
        nextSecret = secret;
      }
    }
    if (nextIndex < 0) break;
    result += text.slice(cursor, nextIndex) + SECRET_MARKER;
    cursor = nextIndex + nextSecret.length;
  }
  return result + text.slice(cursor);
}

function redactUnmarked(text: string): string {
  let result = replaceRegisteredSecrets(text);
  for (const rule of rules) result = result.replace(rule.pattern, rule.marker);
  return result;
}

export function redact(text: string): string {
  let current = text;
  while (true) {
    const next = redactUnmarked(current);
    if (next === current) return next;
    current = next;
  }
}

/**
 * Turn an arbitrary caught error into a stable diagnostic safe for bounded
 * runtime logs: redact registered secrets and token shapes, replace absolute
 * POSIX/Windows/UNC paths with `[path]` so filesystem and Git failures cannot
 * leak repository locations, then truncate to `maxBytes` on a UTF-8 boundary.
 */
export function boundedRedactedDiagnostic(error: unknown, maxBytes: number): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const sanitized = redact(raw)
    .replace(/\\\\[^'"\r\n]*/g, "[path]")
    .replace(/[A-Za-z]:[\\/][^'"\r\n]*/g, "[path]")
    .replace(/\\[^'"\r\n]*/g, "[path]")
    .replace(/\/[^'"\r\n]*/g, "[path]");
  const bytes = Buffer.from(sanitized, "utf8");
  if (bytes.byteLength <= maxBytes) return sanitized;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function redactValue(value: unknown, redactKeys: boolean): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(child => redactValue(child, redactKeys));
  if (value === null || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0)) {
    const redacted = redactValue(child, redactKeys);
    const redactedKeyBase = redactKeys ? redact(key) : key;
    let redactedKey = redactedKeyBase;
    let suffix = 2;
    while (Object.prototype.hasOwnProperty.call(result, redactedKey)) {
      redactedKey = `${redactedKeyBase}#${suffix}`;
      suffix += 1;
    }
    if (DANGEROUS_KEYS.has(redactedKey)) {
      // Define as an own data property instead of assigning, so a
      // `__proto__` key from untrusted input can't hijack result's prototype.
      Object.defineProperty(result, redactedKey, {
        value: redacted,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else {
      result[redactedKey] = redacted;
    }
  }
  return result;
}

export function redactRecord<T>(obj: T): T {
  return redactValue(obj, true) as T;
}

export function redactValues<T>(obj: T): T {
  return redactValue(obj, false) as T;
}
