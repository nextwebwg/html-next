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
