import { defineConfig } from "vite";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ entries: ["counter.html"], hydrate: true })],
  build: {
    outDir: "wwwroot/assets",
    emptyOutDir: true,
    lib: { entry: "main.js", formats: ["es"], fileName: () => "app.js" },
  },
});
