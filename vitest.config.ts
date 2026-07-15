import { defineConfig } from "vitest/config";
// Scope to tests/runtime/ only: all new runtime suites live there. The legacy
// tests/*.test.mjs files are node:test-based and run via `node`/`bash` in
// scripts/validate-release.sh — vitest must not collect them.
export default defineConfig({ test: { include: ["tests/runtime/**/*.test.{ts,mjs}"], environment: "node", testTimeout: 30_000 } });
