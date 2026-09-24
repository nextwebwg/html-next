import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import { pantryPrecompile } from "../precompile.mjs";

const entry = fileURLToPath(new URL("../components/pantry-app.html", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [pantryPrecompile(entry)],
  build: { outDir: "dist", emptyOutDir: true },
});
