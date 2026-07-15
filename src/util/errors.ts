export class RuntimeError extends Error {
  constructor(message: string, readonly detail?: Record<string, unknown>) { super(message); this.name = "RuntimeError"; }
}
export class SpecInvalidError extends RuntimeError {
  constructor(readonly validationErrors: Array<{ path: string; message: string }>) {
    super("delegation spec invalid"); this.name = "SpecInvalidError";
  }
}
export class NestedDelegationError extends RuntimeError {   // CLAUDE_ARCHITECT_DELEGATED already set
  constructor() { super("nested delegation denied"); this.name = "NestedDelegationError"; }
}
export class SpawnFailureError extends RuntimeError {       // child 'error' before start (ENOENT/EACCES)
  constructor(readonly cause: unknown) { super("spawn failure"); this.name = "SpawnFailureError"; }
}
