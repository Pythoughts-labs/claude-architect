import { pathToFileURL } from "node:url";
import { start } from "./mcp/server.js";

export {
  autopilotStartInputSchema,
  autopilotWorkflowInputSchema,
  createServer,
  start,
} from "./mcp/server.js";
export {
  handleAutopilotResume,
  handleAutopilotStart,
  handleAutopilotStatus,
} from "./mcp/tools.js";

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await start();
}
