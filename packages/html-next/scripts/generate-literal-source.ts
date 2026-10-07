import { readFile, writeFile } from "node:fs/promises";

const expression = await readFile(new URL("../src/expression.ts", import.meta.url), "utf8");
const astStart = expression.indexOf("export type ExpressionNode =");
const astEnd = expression.indexOf("\nexport interface CompiledExpression", astStart);
if (astStart === -1 || astEnd === -1) throw new Error("Expression AST declaration not found.");
const types = "type Value = unknown;\n" + expression.slice(astStart, astEnd);
const files = await Promise.all(["identifiers", "expression-parser", "structured-input"].map(async (name) =>
  (await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8")).replace(/^import[^\n]*\n/gm, "")));
const source = [types, ...files].join("\n").replace(/\bExpressionNode\b/g, "HtmlLiteralNode");
const output = new URL("../src/generated/html-literal-source.ts", import.meta.url);
const content = "/** Generated from the canonical AST parser and literal reader. */\nexport const HTML_LITERAL_SOURCE = " + JSON.stringify(source) + ";\n";
if (process.argv.includes("--check")) {
  if (await readFile(output, "utf8") !== content) throw new Error("HTML literal source is stale; run pnpm exec tsx scripts/generate-literal-source.ts.");
} else await writeFile(output, content);
