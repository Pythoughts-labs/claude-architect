const registeredSecrets = new Map<string, number>();
const SECRET_MARKER = "«redacted:secret»";

export interface SecretRegistration {
  dispose(): void;
}

const rules: Array<{ kind: string; re: RegExp }> = [
  { kind: "bearer", re: /(?<=\bBearer[ \t]+)[A-Za-z0-9._~+/=-]+/gi },
  { kind: "key", re: /\bsk-[A-Za-z0-9_-]{8,}\b/g },
  { kind: "github", re: /\bgh[pousr]_[A-Za-z0-9]{8,}\b/g },
  { kind: "aws", re: /\bAKIA[A-Z0-9]{12,}\b/g },
  { kind: "slack", re: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    kind: "env",
    re: /(?<=\b(?:(?:[A-Za-z][A-Za-z0-9]*_)*(?:TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)(?:_[A-Za-z0-9]+)*)=")[^"\r\n]+/gi,
  },
  {
    kind: "env",
    re: /(?<=\b(?:(?:[A-Za-z][A-Za-z0-9]*_)*(?:TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)(?:_[A-Za-z0-9]+)*)=')[^'\r\n]+/gi,
  },
  {
    kind: "env",
    re: /(?<=\b(?:(?:[A-Za-z][A-Za-z0-9]*_)*(?:TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)(?:_[A-Za-z0-9]+)*)=)[^\s,;"']+/gi,
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

export function redact(text: string): string {
  let result = text;
  const secrets = [...registeredSecrets.keys()].sort((a, b) => b.length - a.length);
  for (const secret of secrets) result = result.replaceAll(secret, SECRET_MARKER);
  for (const rule of rules) {
    result = result.replace(rule.re, `«redacted:${rule.kind}»`);
  }
  return result;
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value === null || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const redacted = redactValue(child);
    if (DANGEROUS_KEYS.has(key)) {
      // Define as an own data property instead of assigning, so a
      // `__proto__` key from untrusted input can't hijack result's prototype.
      Object.defineProperty(result, key, {
        value: redacted,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else {
      result[key] = redacted;
    }
  }
  return result;
}

export function redactRecord<T>(obj: T): T {
  return redactValue(obj) as T;
}
