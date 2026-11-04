/**
 * Formats a generated single-file component with dprint: markup_fmt for the SFC and its template,
 * dprint's TypeScript plugin for `<script>`, and malva for `<style>`. All three are Rust, run as Wasm.
 */
import { createContext } from "@dprint/formatter";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript-compiler";

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

const reactPrinter = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

/** Format generated TSX without layout search over deeply nested render props. */
export function formatReact(source: string, filePath: string): string {
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visit(node: ts.Node): void {
    if (ts.isJsxAttributes(node)) ts.setEmitFlags(node, ts.EmitFlags.MultiLine);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return reactPrinter.printFile(file);
}

let svelteContext: ReturnType<typeof createContext> | undefined;

/**
 * Formats a converted Svelte component's script or style, or the shared Svelte module, in `sv
 * create`'s style: tabs and single quotes. Its markup keeps the converter's own layout, which breaks
 * lines inside tags: Svelte renders whitespace between elements as a space.
 */
export function formatSvelteScript(source: string, filePath: string): string {
  if (svelteContext === undefined) {
    svelteContext = createContext({ useTabs: true, lineWidth: 100 });
    svelteContext.addPlugin(readFileSync(require.resolve("@dprint/typescript/plugin.wasm")), { quoteStyle: "alwaysSingle", quoteProps: "asNeeded" });
    svelteContext.addPlugin(readFileSync(require.resolve("dprint-plugin-malva/plugin.wasm")));
  }
  try {
    return svelteContext.formatText({ filePath, fileText: source });
  } catch {
    svelteContext = undefined;
    return source;
  }
}
