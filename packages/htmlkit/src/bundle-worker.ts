import { parentPort, workerData } from "node:worker_threads";
import { build } from "vite";
import { join } from "node:path";
import { browserPlugin } from "./browser.js";
import { rootAlias } from "./config.js";
import type { BrowserBuild, ServerBuild, ServerBundleEntry } from "./bundle.js";

const work = workerData as { readonly browser: BrowserBuild } | { readonly server: ServerBuild };
try {
  const inputs = new Set<string>();
  const entries: Record<string, ServerBundleEntry> = {};
  if ("server" in work) {
    const options = work.server;
    // Packages stay imports, resolved from the application's node_modules where the server runs.
    const result = await build({ root: options.root, configFile: false, mode: "production", publicDir: false, resolve: { alias: rootAlias(options.root) }, logLevel: "silent",
      build: { ssr: true, outDir: options.outDir, emptyOutDir: false, copyPublicDir: false, target: "es2022", minify: false,
        rolldownOptions: { input: options.inputs, output: { format: "es", entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js" } } } });
    for (const output of Array.isArray(result) ? result : [result]) {
      if (!("output" in output)) continue;
      for (const chunk of output.output) if (chunk.type === "chunk") {
        for (const file of chunk.moduleIds) if (!file.startsWith("\0")) inputs.add(file);
        if (chunk.isEntry) entries[chunk.name] = { file: chunk.fileName, exports: chunk.exports };
      }
    }
  } else {
    const options = work.browser;
    await build({ root: options.root, configFile: false, mode: "production", base: options.base, publicDir: join(options.root, "public"), resolve: { alias: rootAlias(options.root) },
      logLevel: "silent", plugins: [browserPlugin(options.sources, inputs)],
      build: { outDir: options.outDir, emptyOutDir: false, copyPublicDir: false, assetsDir: "_htmlkit", target: "es2022", manifest: "_htmlkit/vite-manifest.json", modulePreload: false,
        rolldownOptions: { input: Object.fromEntries([...options.sources.keys()].filter(id => id.startsWith("virtual:htmlkit/page-")).map(id => [id.slice("virtual:htmlkit/".length), id])),
          output: { entryFileNames: "_htmlkit/[name]-[hash].js", chunkFileNames: "_htmlkit/[name]-[hash].js", assetFileNames: "_htmlkit/[name]-[hash][extname]" } } },
    });
  }
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node MessagePort has no origin.
  parentPort!.postMessage({ inputs: [...inputs].sort(), entries });
} catch (error) {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node MessagePort has no origin.
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally { parentPort!.close(); }
