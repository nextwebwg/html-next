#!/usr/bin/env node
import { resolveConfig } from "vite";

// Loading the user's Vite config runs the same adapter preparation used by dev and build.
try {
  const config = await resolveConfig({ logLevel: "error" }, "build");
  if (!config.plugins.some((plugin) => plugin.name === "html-next-framework")) {
    throw new Error('Configure htmlNext({ target: "vue" | "react" | "svelte" }) in vite.config before running html-next-sync.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
