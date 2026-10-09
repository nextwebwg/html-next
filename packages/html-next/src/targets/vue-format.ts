/**
 * Formats a generated single-file component with dprint: markup_fmt for the SFC and its template,
 * dprint's TypeScript plugin for `<script>`, and malva for `<style>`. All three are Rust, run as Wasm.
 */
import { createContext } from "@dprint/formatter";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let context: ReturnType<typeof createContext> | undefined;

export function formatVue(source: string, filePath: string): string {
  if (context === undefined) {
    context = createContext({ indentWidth: 2, lineWidth: 100 });
    // Vue's own convention (create-vue, the Vue docs): single quotes and no semicolons.
    context.addPlugin(readFileSync(require.resolve("@dprint/typescript/plugin.wasm")), { quoteStyle: "alwaysSingle", quoteProps: "asNeeded", semiColons: "asi" });
    context.addPlugin(readFileSync(require.resolve("dprint-plugin-malva/plugin.wasm")));
    // Vue drops whitespace-only text between elements, but not around inline text; "css" keeps that.
    context.addPlugin(readFileSync(require.resolve("dprint-plugin-markup/plugin.wasm")), { whitespaceSensitivity: "css" });
  }
  return context.formatText({ filePath, fileText: source });
}

let reactContext: ReturnType<typeof createContext> | undefined;

/**
 * Formats generated React TSX with dprint's TypeScript plugin, in React's usual double quotes and
 * semicolons. Formatting only lays the code out: when dprint cannot (its Wasm printer can run out of
 * memory on deeply nested render props), the component keeps its unformatted, equally valid source.
 */
export function formatReact(source: string, filePath: string): string {
  if (reactContext === undefined) {
    reactContext = createContext({ indentWidth: 2, lineWidth: 100 });
    reactContext.addPlugin(readFileSync(require.resolve("@dprint/typescript/plugin.wasm")));
  }
  try {
    return reactContext.formatText({ filePath, fileText: source });
  } catch {
    // ponytail: a failed Wasm instance is discarded whole; flatten the nested output if this recurs.
    reactContext = undefined;
    return source;
  }
}

let svelteContext: ReturnType<typeof createContext> | undefined;

/**
 * Formats a converted Svelte component's script, or the shared Svelte module, in `sv create`'s
 * style: tabs and single quotes. Its markup keeps the converter's own layout, which breaks lines
 * inside tags: Svelte renders whitespace between elements as a space.
 */
export function formatSvelteScript(source: string, filePath: string): string {
  if (svelteContext === undefined) {
    svelteContext = createContext({ useTabs: true, lineWidth: 100 });
    svelteContext.addPlugin(readFileSync(require.resolve("@dprint/typescript/plugin.wasm")), { quoteStyle: "alwaysSingle", quoteProps: "asNeeded" });
  }
  try {
    return svelteContext.formatText({ filePath, fileText: source });
  } catch {
    svelteContext = undefined;
    return source;
  }
}
