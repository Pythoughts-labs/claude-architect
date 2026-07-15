// Prints argv[2] to stdout, argv[3] to stderr, then sleeps argv[4] ms. Ignores SIGTERM if argv[5]==="stubborn".
const [, , out, err, sleepMs, mode] = process.argv;
if (out) process.stdout.write(out);
if (err) process.stderr.write(err);
if (mode === "stubborn") process.on("SIGTERM", () => {});
setTimeout(() => process.exit(0), Number(sleepMs ?? 0));
