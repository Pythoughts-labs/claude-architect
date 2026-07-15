type Level = "debug" | "info" | "warn" | "error";
function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  const line = JSON.stringify({ t: level, msg, ...(meta ?? {}) });
  process.stderr.write(line + "\n");   // NEVER stdout: stdout carries the MCP protocol
}
export const logger = {
  debug: (m: string, meta?: Record<string, unknown>) => emit("debug", m, meta),
  info: (m: string, meta?: Record<string, unknown>) => emit("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit("error", m, meta),
};
