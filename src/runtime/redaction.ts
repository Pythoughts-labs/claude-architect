const registeredSecrets = new Map<string, number>();
const SECRET_MARKER = "«redacted:secret»";
const REDACTION_MARKER = /«redacted:(?:secret|bearer|key|github|aws|slack|jwt|env)»/g;

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
  for (const rule of rules) {
    result = result.replace(rule.re, `«redacted:${rule.kind}»`);
  }
  return result;
}

export function redact(text: string): string {
  let cursor = 0;
  let result = "";
  for (const match of text.matchAll(REDACTION_MARKER)) {
    const index = match.index;
    result += redactUnmarked(text.slice(cursor, index)) + match[0];
    cursor = index + match[0].length;
  }
  return result + redactUnmarked(text.slice(cursor));
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
