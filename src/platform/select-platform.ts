import { PosixPlatformServices } from "./posix-platform-services.js";
import type { PlatformServices } from "./platform-services.js";
import { WindowsPlatformServices } from "./windows-platform-services.js";

let services: PlatformServices | undefined;
export function getPlatformServices(): PlatformServices {
  if (!services) services = process.platform === "win32"
    ? new WindowsPlatformServices()
    : new PosixPlatformServices();
  return services;
}
