import { fileURLToPath } from "node:url";

import { build } from "esbuild";

await build({
  entryPoints: [fileURLToPath(new URL("../src/browser-loader.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/browser-loader.bundle.js", import.meta.url)),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  legalComments: "none",
  minify: true,
});

await build({
  entryPoints: [fileURLToPath(new URL("../src/browser.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/browser.js", import.meta.url)),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  legalComments: "none",
  minify: true,
});
