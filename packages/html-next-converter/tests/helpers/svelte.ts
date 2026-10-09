import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, sep } from "node:path";
import { transform, type Plugin } from "esbuild";
import { compile, compileModule } from "svelte/compiler";

/** The CSS Svelte extracts from each component's `<style>`, by real path, as a bundler would emit it. */
const styles = new Map<string, string>();

/** Every compiled component's CSS under `directory`. */
export function svelteStyles(directory: string): string {
  const real = realpathSync(directory) + sep;
  return [...styles].filter(([path]) => path.startsWith(real)).map(([, css]) => css).join("\n");
}

/** A component's compiled JavaScript; its CSS joins `svelteStyles()`. Svelte's style hash derives from `path`. */
export async function compileSvelteFile(path: string, generate: "client" | "server" = "client"): Promise<string> {
  const compiled = compile(await readFile(path, "utf8"), { filename: path, generate });
  if (compiled.css !== null) styles.set(realpathSync(path), compiled.css.code);
  return compiled.js.code;
}

export function sveltePlugin(generate: "client" | "server"): Plugin {
  return { name: `svelte-${generate}`, setup(plugin) {
    plugin.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => ({
      contents: compileModule((await transform(await readFile(path, "utf8"), { loader: "ts" })).code, { filename: path, generate }).js.code,
      loader: "js",
      resolveDir: dirname(path),
    }));
    plugin.onLoad({ filter: /\.svelte$/ }, async ({ path }) => ({
      contents: await compileSvelteFile(path, generate),
      loader: "js",
      resolveDir: dirname(path),
    }));
  } };
}
