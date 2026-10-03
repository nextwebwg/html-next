import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Plugin } from "esbuild";
import { compile } from "svelte/compiler";

export function sveltePlugin(generate: "client" | "server"): Plugin {
  return { name: `svelte-${generate}`, setup(plugin) {
    plugin.onLoad({ filter: /\.svelte$/ }, async ({ path }) => ({
      contents: compile(await readFile(path, "utf8"), { filename: path, generate }).js.code,
      loader: "js",
      resolveDir: dirname(path),
    }));
  } };
}

