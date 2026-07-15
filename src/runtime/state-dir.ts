import { tmpdir } from "node:os";
import nodeProcess from "node:process";
import { RuntimeError } from "../util/errors.js";

export function resolveStateDir(): string {
  if (nodeProcess.env.CLAUDE_PLUGIN_DATA) return nodeProcess.env.CLAUDE_PLUGIN_DATA;
  if (nodeProcess.env.NODE_ENV === "test") {
    return nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR ?? tmpdir();
  }
  throw new RuntimeError("CLAUDE_PLUGIN_DATA is required outside test environments");
}
