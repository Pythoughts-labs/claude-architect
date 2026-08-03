import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const helpers = [
  {
    path: "native/bin/win32-job-kill-x64.exe",
    sha256: "a96636f4d9e564b978172662e005e2a521205dd3b2eaea271b511854a05ccd10",
    machine: 0x8664,
  },
  {
    path: "native/bin/win32-job-kill-arm64.exe",
    sha256: "7ad8352f04a098212dc8884dbf9d02f9f3edb56ccc2f417a6b5bf8bdf960cc93",
    machine: 0xaa64,
  },
  {
    path: "native/bin/win32-filesystem-x64.exe",
    sha256: "885fef33c51d87ba5dff3cb9f8bdd6c175166417c4a5c789fef3131c02ad06a4",
    machine: 0x8664,
  },
  {
    path: "native/bin/win32-filesystem-arm64.exe",
    sha256: "bd16b22da97bc31ca69515bb2222c7b8220e2c2b8353b1c6f1ced6850c9ec280",
    machine: 0xaa64,
  },
];

for (const helper of helpers) {
  const bytes = await readFile(helper.path);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== helper.sha256) {
    throw new Error(`${helper.path} SHA-256 mismatch`);
  }
  if (bytes.length < 0x40) throw new Error(`${helper.path} is not a PE executable`);
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 6 > bytes.length
    || bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0"
    || bytes.readUInt16LE(peOffset + 4) !== helper.machine) {
    throw new Error(`${helper.path} PE architecture mismatch`);
  }
}

console.log("PASS: packaged native helper hashes and architectures are verified.");
