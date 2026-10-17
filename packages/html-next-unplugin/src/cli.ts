#!/usr/bin/env node
import { resolveConfig } from "vite";

// Loading the user's Vite config runs the same adapter preparation used by dev and build. The
// framework adapter prepares while the config resolves; the native plugin writes on `api.sync`.
try {
  const config = await resolveConfig({ logLevel: "error" }, "build");
  const native = config.plugins.find((plugin) => plugin.name === "html-next");
  if (native !== undefined) await (native.api as { sync(): Promise<void> }).sync();
  else if (!config.plugins.some((plugin) => plugin.name === "html-next-framework")) {
    throw new Error("Configure htmlNext() in vite.config before running html-next-sync.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
