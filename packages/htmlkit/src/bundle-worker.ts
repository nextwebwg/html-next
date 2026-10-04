import { parentPort, workerData } from "node:worker_threads";
import { build } from "vite";
import { join } from "node:path";
import { browserPlugin } from "./browser.js";
import type { BrowserBuild } from "./bundle.js";

const options = workerData as BrowserBuild;
try {
  const inputs = new Set<string>();
  await build({ root: options.root, configFile: false, mode: "production", base: options.base, publicDir: join(options.root, "public"),
    logLevel: "silent", plugins: [browserPlugin(options.sources, inputs)],
    build: { outDir: options.outDir, emptyOutDir: false, copyPublicDir: false, assetsDir: "_htmlkit", target: "es2022", manifest: "_htmlkit/vite-manifest.json", modulePreload: false,
      rolldownOptions: { input: Object.fromEntries([...options.sources.keys()].filter(id => id.startsWith("virtual:htmlkit/")).map((id, i) => [`page-${i}`, id])),
        output: { entryFileNames: "_htmlkit/[name]-[hash].js", chunkFileNames: "_htmlkit/[name]-[hash].js", assetFileNames: "_htmlkit/[name]-[hash][extname]" } } },
  });
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node MessagePort has no origin.
  parentPort!.postMessage({ inputs: [...inputs].sort() });
} catch (error) {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node MessagePort has no origin.
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally { parentPort!.close(); }
