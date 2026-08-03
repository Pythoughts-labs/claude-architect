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
    sha256: "6562c2ab80c102a98c971f034396d4ee3360f4415ff589a8daceffa39a3d722e",
    machine: 0x8664,
  },
  {
    path: "native/bin/win32-filesystem-arm64.exe",
    sha256: "19ac23c91fe1be69f27aa1c7c676831ea7832650aaa1fad8a7bc52cf50e1d3d9",
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
