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

// Converted components carry the decimal operations' source. Their public names (`add`) are common
// authored names, so the shared host modules export them as `decimalAdd` and so on.
const decimal = await readFile(new URL("../src/decimal.ts", import.meta.url), "utf8");
const decimalSource = decimal.slice(decimal.indexOf("*/\n") + 3).trimStart()
  .replace(/\b(add|subtract|multiply|divide|remainder)\(/g, (_, name: string) => `decimal${name[0]!.toUpperCase()}${name.slice(1)}(`);
const decimalOutput = new URL("../src/generated/decimal-source.ts", import.meta.url);
const decimalContent = "/** Generated from src/decimal.ts by scripts/generate-literal-source.ts. */\nexport const DECIMAL_SOURCE = "
  + JSON.stringify(decimalSource) + ";\n";
if (process.argv.includes("--check")) {
  if (await readFile(decimalOutput, "utf8").catch(() => "") !== decimalContent) {
    throw new Error("Decimal source is stale; run pnpm exec tsx scripts/generate-literal-source.ts.");
  }
} else await writeFile(decimalOutput, decimalContent);
