import { registerSecretValue } from "./redaction.js";
import type { SecretRegistration } from "./redaction.js";
import { RuntimeError } from "../util/errors.js";

export type EnvironmentOS = "darwin" | "linux" | "win32";
export type EnvSource = "platform" | "adapter" | "spec";

export interface EnvProvenanceEntry {
  name: string;
  source: EnvSource;
}

export type EnvProvenance = EnvProvenanceEntry[];

export interface BuildEnvironmentArgs {
  os: EnvironmentOS;
  adapterAllowlist: string[];
  specAdditions?: Record<string, string>;
  tempHome?: string;
}

export interface BuiltEnvironment {
  env: Record<string, string>;
  provenance: EnvProvenance;
  secretRegistration: SecretRegistration;
}

const POSIX_ESSENTIAL_ENV = [
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
] as const;

const SENSITIVE_ENV_NAME =
  /^(?:[A-Za-z][A-Za-z0-9]*_)*(?:TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)(?:_[A-Za-z0-9]+)*$/i;

const COMMON_SENSITIVE_ENV_NAMES = new Set([
  "GOOGLE_APPLICATION_CREDENTIALS",
  "MYSQL_PWD",
  "PGPASSWORD",
  "REDISCLI_AUTH",
]);

function normalizeEnvironmentName(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase();
}

function isSensitiveEnvironmentName(name: string): boolean {
  const normalized = normalizeEnvironmentName(name);
  return SENSITIVE_ENV_NAME.test(normalized) || COMMON_SENSITIVE_ENV_NAMES.has(normalized);
}

function validateEnvironmentName(name: string): void {
  if (name.length === 0 || name.includes("=") || name.includes("\0")) {
    throw new RuntimeError(`invalid environment variable name: ${JSON.stringify(name)}`);
  }
}

function validateEnvironmentValue(name: string, value: string): void {
  if (value.includes("\0")) {
    throw new RuntimeError(`invalid environment variable value for ${JSON.stringify(name)}`);
  }
}

function combineSecretRegistrations(registrations: SecretRegistration[]): SecretRegistration {
  let active = true;
  return {
    dispose(): void {
      if (!active) return;
      active = false;
      for (const registration of registrations) registration.dispose();
    },
  };
}

function registerSensitiveValues(
  environment: Record<string, string | undefined>,
  validateEntries: boolean,
): SecretRegistration {
  const registrations: SecretRegistration[] = [];
  try {
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) continue;
      if (validateEntries) {
        validateEnvironmentName(name);
        validateEnvironmentValue(name, value);
      }
      if (isSensitiveEnvironmentName(name)) {
        registrations.push(registerSecretValue(value));
      }
    }
    return combineSecretRegistrations(registrations);
  } catch (error) {
    combineSecretRegistrations(registrations).dispose();
    throw error;
  }
}

export function registerSensitiveEnvironment(
  environment: Record<string, string | undefined>,
): SecretRegistration {
  return registerSensitiveValues(environment, true);
}

function setEnvironmentValue(
  environment: Record<string, string>,
  provenance: Map<string, EnvSource>,
  name: string,
  value: string,
  source: EnvSource,
): void {
  validateEnvironmentName(name);
  validateEnvironmentValue(name, value);
  Object.defineProperty(environment, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  provenance.set(name, source);
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildEnvironment(
  args: BuildEnvironmentArgs,
): BuiltEnvironment {
  const env: Record<string, string> = {};
  const provenance = new Map<string, EnvSource>();
  const hostSecretRegistration = registerSensitiveValues(process.env, false);

  try {
    const platformNames = args.os === "win32" ? [] : POSIX_ESSENTIAL_ENV;
    for (const name of platformNames) {
      if (args.tempHome !== undefined && name.startsWith("XDG_")) continue;
      const value = process.env[name];
      if (value !== undefined) {
        setEnvironmentValue(env, provenance, name, value, "platform");
      }
    }

    if (args.tempHome !== undefined) {
      setEnvironmentValue(env, provenance, "HOME", args.tempHome, "platform");
    }

    for (const name of args.adapterAllowlist) {
      validateEnvironmentName(name);
      if (args.tempHome !== undefined && name.startsWith("XDG_")) continue;
      if (!Object.prototype.hasOwnProperty.call(process.env, name)) continue;
      const value = process.env[name];
      if (value !== undefined) {
        setEnvironmentValue(env, provenance, name, value, "adapter");
      }
    }

    for (const [name, value] of Object.entries(args.specAdditions ?? {})) {
      setEnvironmentValue(env, provenance, name, value, "spec");
    }

    setEnvironmentValue(
      env,
      provenance,
      "CLAUDE_ARCHITECT_DELEGATED",
      "1",
      "platform",
    );
    const environmentSecretRegistration = registerSensitiveEnvironment(env);

    return {
      env,
      provenance: [...provenance.entries()]
        .map(([name, source]) => ({ name, source }))
        .sort((left, right) => compareNames(left.name, right.name)),
      secretRegistration: combineSecretRegistrations([
        hostSecretRegistration,
        environmentSecretRegistration,
      ]),
    };
  } catch (error) {
    hostSecretRegistration.dispose();
    throw error;
  }
}
