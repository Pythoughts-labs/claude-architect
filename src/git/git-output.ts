import { RuntimeError } from "../util/errors.js";

/** Decode Git path records while preserving every character except their NUL delimiters. */
export function gitNulRecords(stdout: string, description: string): string[] {
  if (stdout.length === 0) return [];
  if (!stdout.endsWith("\0")) {
    throw new RuntimeError(`${description} did not end with its NUL record delimiter`);
  }
  return stdout.slice(0, -1).split("\0");
}

export function gitPathOutput(stdout: string, description: string): string {
  if (!stdout.endsWith("\n")) {
    throw new RuntimeError(`${description} did not end with its record delimiter`);
  }
  const pathname = stdout.slice(0, -1);
  if (pathname.length === 0 || pathname.includes("\0")) {
    throw new RuntimeError(`${description} is malformed`);
  }
  return pathname;
}
