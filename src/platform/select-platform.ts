import { RuntimeError } from "../util/errors.js";
import { PosixPlatformServices } from "./posix-platform-services.js";
import type {
  CanonicalPath, CheckoutLock, ExecutableRequest, PlatformServices, ResolvedExecutable,
  SpawnRequest, SupervisedProcess,
} from "./platform-services.js";

export class UnsupportedPlatformError extends RuntimeError {
  readonly code = "unsupported-platform" as const;
  constructor() { super("runtime operations are unsupported on win32"); this.name = "UnsupportedPlatformError"; }
}

class DiagnosticsOnlyPlatformServices implements PlatformServices {
  readonly os = "win32" as const;
  private readonly diagnostics = new PosixPlatformServices();

  resolveExecutable(request: ExecutableRequest): Promise<ResolvedExecutable> {
    return this.diagnostics.resolveExecutable(request);
  }
  canonicalizePath(input: string): Promise<CanonicalPath> {
    return this.diagnostics.canonicalizePath(input);
  }
  async spawnSupervised(_request: SpawnRequest): Promise<SupervisedProcess> { throw new UnsupportedPlatformError(); }
  async requestCooperativeCancellation(_process: SupervisedProcess): Promise<void> { throw new UnsupportedPlatformError(); }
  async terminateProcessTree(_process: SupervisedProcess): Promise<void> { throw new UnsupportedPlatformError(); }
  async getProcessStartToken(_pid: number): Promise<string | null> { throw new UnsupportedPlatformError(); }
  async terminateProcessTreeByPid(_pid: number, _expectedToken?: string | null): Promise<void> { throw new UnsupportedPlatformError(); }
  async acquireCheckoutLock(_checkout: string): Promise<CheckoutLock> { throw new UnsupportedPlatformError(); }
  async createSecureTempDirectory(): Promise<string> { throw new UnsupportedPlatformError(); }
}

let services: PlatformServices | undefined;
export function getPlatformServices(): PlatformServices {
  if (!services) services = process.platform === "win32"
    ? new DiagnosticsOnlyPlatformServices()
    : new PosixPlatformServices();
  return services;
}
