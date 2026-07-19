// Prints argv[2] to stdout, argv[3] to stderr, then sleeps argv[4] ms. Ignores SIGTERM if argv[5]==="stubborn".
// If argv[6] is set, writes argv[7] (default "partial\n") to that path before sleeping.
import { writeFileSync } from "node:fs";
const [, , out, err, sleepMs, mode, writeTarget, writeContent] = process.argv;
if (out) process.stdout.write(out);
if (err) process.stderr.write(err);
if (writeTarget) writeFileSync(writeTarget, writeContent || "partial\n");
if (mode === "stubborn") process.on("SIGTERM", () => {});
setTimeout(() => process.exit(0), Number(sleepMs ?? 0));
