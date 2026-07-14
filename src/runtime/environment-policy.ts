import { registerSecretValue } from "./redaction.js";

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

export function registerSensitiveEnvironment(
  environment: Record<string, string | undefined>,
): void {
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && SENSITIVE_ENV_NAME.test(name)) {
      registerSecretValue(value);
    }
  }
}

function setEnvironmentValue(
  environment: Record<string, string>,
  provenance: Map<string, EnvSource>,
  name: string,
  value: string,
  source: EnvSource,
): void {
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
): { env: Record<string, string>; provenance: EnvProvenance } {
  const env: Record<string, string> = {};
  const provenance = new Map<string, EnvSource>();

  registerSensitiveEnvironment(process.env);

  const platformNames = args.os === "win32" ? [] : POSIX_ESSENTIAL_ENV;
  for (const name of platformNames) {
    const value = process.env[name];
    if (value !== undefined) {
      setEnvironmentValue(env, provenance, name, value, "platform");
    }
  }

  if (args.tempHome !== undefined) {
    setEnvironmentValue(env, provenance, "HOME", args.tempHome, "platform");
  }

  for (const name of args.adapterAllowlist) {
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
  registerSensitiveEnvironment(env);

  return {
    env,
    provenance: [...provenance.entries()]
      .map(([name, source]) => ({ name, source }))
      .sort((left, right) => compareNames(left.name, right.name)),
  };
}
