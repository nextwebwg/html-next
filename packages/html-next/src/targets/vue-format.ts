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
    // Preserve authored text boundaries when formatting generated markup.
    context.addPlugin(readFileSync(require.resolve("dprint-plugin-markup/plugin.wasm")), { whitespaceSensitivity: "strict" });
  }
  return context.formatText({ filePath, fileText: source });
}

const reactPrinter = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

/** Fold generated JSX inputs into one ordered object without introducing a rendering component. */
export function jsxAttributeRecord(attributes: readonly string[]): string {
  const file = ts.createSourceFile("attributes.tsx", `<Target ${attributes.join(" ")} />`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const element = (file.statements[0] as ts.ExpressionStatement).expression as ts.JsxSelfClosingElement;
  const names = new Set<string>();
  const properties: ts.ObjectLiteralElementLike[] = element.attributes.properties.map(attribute => {
    if (ts.isJsxSpreadAttribute(attribute)) return ts.factory.createSpreadAssignment(attribute.expression);
    const name = attribute.name.getText(file);
    const initializer = attribute.initializer;
    const value = initializer === undefined ? ts.factory.createTrue() : ts.isStringLiteral(initializer)
      ? ts.factory.createStringLiteral(initializer.text) : ts.isJsxExpression(initializer) ? initializer.expression ?? ts.factory.createTrue() : initializer;
    const property = ts.factory.createPropertyAssignment(name === "__proto__" ? ts.factory.createComputedPropertyName(ts.factory.createStringLiteral(name)) : ts.factory.createStringLiteral(name), value);
    if (names.has(name)) return ts.factory.createSpreadAssignment(ts.factory.createObjectLiteralExpression([property]));
    names.add(name);
    return property;
  });
  return reactPrinter.printNode(ts.EmitHint.Expression, ts.factory.createObjectLiteralExpression(properties), file);
}

/** Separate imports, types and functions without touching strings or template content. */
function separateSections(source: string, filePath: string): string {
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const breaks: number[] = [];
  function visit(node: ts.Node): void {
    if (ts.isSourceFile(node) || ts.isBlock(node)) {
      for (let index = 1; index < node.statements.length; index++) {
        const previous = node.statements[index - 1]!;
        const current = node.statements[index]!;
        if (ts.isFunctionDeclaration(previous) || ts.isFunctionDeclaration(current)
          || ts.isImportDeclaration(previous) && !ts.isImportDeclaration(current)
          || ts.isTypeAliasDeclaration(previous) || ts.isInterfaceDeclaration(previous)
          || ts.isReturnStatement(current)) {
          breaks.push(current.getStart(file));
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  const sections: string[] = [];
  let start = 0;
  for (const position of breaks.sort((a, b) => a - b)) {
    sections.push(source.slice(start, position).trimEnd());
    start = position;
  }
  sections.push(source.slice(start));
  return sections.join("\n\n");
}

/** Lay out JSX deterministically, without searching combinations of nested render-prop layouts. */
export function formatReact(source: string, filePath: string): string {
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  source = reactPrinter.printFile(file);
  const printed = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const breaks = new Set<number>();
  function visit(node: ts.Node): void {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.getText(printed).length > 100) {
        for (const attribute of node.attributes.properties) breaks.add(attribute.getStart(printed));
        breaks.add(node.end - (ts.isJsxSelfClosingElement(node) ? 2 : 1));
      }
    }
    if (ts.isJsxElement(node) && node.children.length > 1
      && node.children.every((child) => !ts.isJsxText(child))) {
      for (const child of node.children) breaks.add(child.getStart(printed));
      breaks.add(node.closingElement.getStart(printed));
    }
    if (ts.isParenthesizedExpression(node) && (ts.isJsxElement(node.expression) || ts.isJsxSelfClosingElement(node.expression))) {
      breaks.add(node.expression.getStart(printed));
      breaks.add(node.end - 1);
    }
    if (ts.isBlock(node) && node.statements.length > 0) {
      for (const statement of node.statements) breaks.add(statement.getStart(printed));
      breaks.add(node.end - 1);
    }
    ts.forEachChild(node, visit);
  }
  visit(printed);
  for (const position of [...breaks].sort((a, b) => b - a)) {
    if (!/\n[ \t]*$/.test(source.slice(0, position))) {
      source = source.slice(0, position) + "\n" + source.slice(position);
    }
  }
  source = separateSections(source, filePath);
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => ({ jsx: ts.JsxEmit.Preserve }),
    getScriptFileNames: () => [filePath],
    getScriptVersion: () => "0",
    getScriptSnapshot: (name) => name === filePath ? ts.ScriptSnapshot.fromString(source) : undefined,
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => "lib.d.ts",
    fileExists: (name) => name === filePath,
    readFile: (name) => name === filePath ? source : undefined,
  };
  const service = ts.createLanguageService(host);
  try {
    const edits = service.getFormattingEditsForDocument(filePath, {
      ...ts.getDefaultFormatCodeSettings(),
      indentSize: 2, tabSize: 2, convertTabsToSpaces: true, newLineCharacter: "\n",
    });
    for (const { span, newText } of edits.sort((a, b) => b.span.start - a.span.start)) {
      source = source.slice(0, span.start) + newText + source.slice(span.start + span.length);
    }
    return source;
  } finally {
    service.dispose();
  }
}

let svelteContext: ReturnType<typeof createContext> | undefined;

/**
 * Formats a converted Svelte component's script or style, or the shared Svelte module, with two-space
 * indentation and single quotes. Its markup keeps the converter's own layout, which breaks
 * lines inside tags: Svelte renders whitespace between elements as a space.
 */
export function formatSvelteScript(source: string, filePath: string): string {
  if (svelteContext === undefined) {
    svelteContext = createContext({ indentWidth: 2, lineWidth: 100 });
    svelteContext.addPlugin(readFileSync(require.resolve("@dprint/typescript/plugin.wasm")), { quoteStyle: "alwaysSingle", quoteProps: "asNeeded" });
    svelteContext.addPlugin(readFileSync(require.resolve("dprint-plugin-malva/plugin.wasm")));
  }
  try {
    return svelteContext.formatText({ filePath, fileText: /\.[cm]?tsx?$/.test(filePath) ? separateSections(source, filePath) : source });
  } catch {
    svelteContext = undefined;
    return source;
  }
}
