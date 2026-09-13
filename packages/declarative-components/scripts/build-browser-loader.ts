import { build } from "esbuild";

await build({
  entryPoints: [new URL("../src/browser-loader.ts", import.meta.url).pathname],
  outfile: new URL("../dist/browser-loader.bundle.js", import.meta.url).pathname,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  legalComments: "none",
  minify: true,
});

await build({
  entryPoints: [new URL("../src/browser.ts", import.meta.url).pathname],
  outfile: new URL("../dist/browser.js", import.meta.url).pathname,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  legalComments: "none",
  minify: true,
});
