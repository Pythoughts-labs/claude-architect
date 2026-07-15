import { pathToFileURL } from "node:url";
import { start } from "./mcp/server.js";

export { start };

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await start();
}
