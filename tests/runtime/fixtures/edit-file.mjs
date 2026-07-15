import { writeFile } from "node:fs/promises";

const [target, requestedContent, requestedExitCode = "0"] = process.argv.slice(2);
if (target === undefined || requestedContent === undefined) {
  throw new Error("usage: edit-file.mjs <target> <content|__HOME__> [exit-code]");
}

const content = requestedContent === "__HOME__" ? (process.env.HOME ?? "") : requestedContent;
await writeFile(target, content);
process.exitCode = Number(requestedExitCode);
