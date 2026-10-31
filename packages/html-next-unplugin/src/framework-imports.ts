import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import MagicString from "magic-string";
import ts from "typescript";
import type { FrameworkTarget } from "@nextwebwg/html-next-converter";

interface ComponentExport { readonly file: string; readonly name: string }
type ComponentExports = ReadonlyMap<string, ComponentExport>;

/** Route named imports through pure component barrels before a bundler scans unused controllers. */
export class FrameworkImports {
  private readonly exports = new Map<string, ComponentExports | undefined>();
  constructor(private readonly root: string, private readonly target: FrameworkTarget,
    private readonly aliases: ReadonlyMap<string, string>, private readonly components: ReadonlySet<string>) {}

  private async componentExports(file: string, parents = new Set<string>()): Promise<ComponentExports | undefined> {
    if (parents.has(file)) return undefined;
    if (this.exports.has(file)) return this.exports.get(file);
    if (this.components.has(file)) {
      return new Map([["default", { file, name: "default" }]]);
    }
    const parsed = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    const result = new Map<string, ComponentExport>();
    const active = new Set([...parents, file]);
    for (const statement of parsed.statements) {
      // Authored code, side-effect imports and namespace exports retain their ordinary module semantics.
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.exportClause && !ts.isNamedExports(statement.exportClause) || statement.attributes) return undefined;
      if (statement.isTypeOnly) continue;
      if (!statement.moduleSpecifier.text.startsWith(".")) return undefined;
      const child = await this.componentExports(resolve(dirname(file), statement.moduleSpecifier.text), active);
      if (child === undefined) return undefined;
      const entries = statement.exportClause === undefined ? [...child].filter(([name]) => name !== "default")
        : statement.exportClause.elements.filter(item => !item.isTypeOnly).map(item =>
          [item.name.text, child.get((item.propertyName ?? item.name).text)] as const);
      for (const [name, value] of entries) {
        const previous = result.get(name);
        if (value === undefined || previous && (previous.file !== value.file || previous.name !== value.name)) return undefined;
        result.set(name, value);
      }
    }
    this.exports.set(file, result);
    return result;
  }

  async rewrite(code: string, id: string): Promise<{ code: string; map: ReturnType<MagicString["generateMap"]> } | undefined> {
    if (![...this.aliases.keys()].some(name => code.includes(name))) return undefined;
    let ranges: readonly { start: number; end: number; jsx?: boolean }[] = [{ start: 0, end: code.length, jsx: /\.[jt]sx$/.test(id.split("?")[0]!) }];
    const require = createRequire(resolve(this.root, "package.json"));
    if (this.target === "vue" && id.endsWith(".vue")) {
      const compiler = await import(pathToFileURL(require.resolve("vue/compiler-sfc")).href) as typeof import("vue/compiler-sfc");
      const { descriptor } = compiler.parse(code, { filename: id });
      ranges = [descriptor.script, descriptor.scriptSetup].flatMap(script => script ? [{ start: script.loc.start.offset, end: script.loc.end.offset, jsx: script.lang === "tsx" || script.lang === "jsx" }] : []);
    } else if (this.target === "svelte" && id.endsWith(".svelte")) {
      const compiler = await import(pathToFileURL(require.resolve("svelte/compiler")).href) as typeof import("svelte/compiler");
      const parsed = compiler.parse(code, { filename: id, modern: true });
      ranges = [parsed.instance, parsed.module].flatMap(script => {
        if (!script) return [];
        const start: unknown = Reflect.get(script.content, "start"), end: unknown = Reflect.get(script.content, "end");
        if (typeof start !== "number" || typeof end !== "number") throw new Error("The Svelte parser did not report its script range.");
        return [{ start, end }];
      });
    }
    const output = new MagicString(code);
    for (const range of ranges) {
      const parsed = ts.createSourceFile(id, code.slice(range.start, range.end), ts.ScriptTarget.Latest, true,
        range.jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      for (const statement of parsed.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier) || statement.attributes) continue;
        const entry = this.aliases.get(statement.moduleSpecifier.text);
        if (entry === undefined) continue;
        const imported = ts.isImportDeclaration(statement);
        let elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[] = [];
        let defaultImport: ts.Identifier | undefined;
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause;
          if (!clause || clause.isTypeOnly || clause.namedBindings && !ts.isNamedImports(clause.namedBindings)) continue;
          defaultImport = clause.name;
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) elements = clause.namedBindings.elements;
        } else {
          if (statement.isTypeOnly || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
          elements = statement.exportClause.elements;
        }
        const names = [...(defaultImport ? [{ from: "default", to: defaultImport.getText(parsed) }] : []),
          ...elements.filter(item => !item.isTypeOnly).map(item => ({ from: (item.propertyName ?? item.name).text, to: item.name.getText(parsed) }))];
        if (names.length === 0) continue;
        const exports = await this.componentExports(entry);
        if (exports === undefined || names.some(name => !exports.has(name.from))) continue;
        const replacements = names.map(name => {
          const target = exports.get(name.from)!;
          return `${imported ? "import" : "export"} { ${target.name} as ${name.to} } from ${JSON.stringify(target.file.replaceAll("\\", "/"))};`;
        });
        const types = elements.filter(item => item.isTypeOnly);
        if (types.length) replacements.push(`${imported ? "import" : "export"} type { ${types.map(item => item.propertyName
          ? `${item.propertyName.getText(parsed)} as ${item.name.getText(parsed)}` : item.name.getText(parsed)).join(", ")} } from ${statement.moduleSpecifier.getText(parsed)};`);
        output.overwrite(range.start + statement.getStart(parsed), range.start + statement.end, replacements.join("\n"));
      }
    }
    return output.hasChanged() ? { code: output.toString(), map: output.generateMap({ hires: true, source: id, includeContent: true }) } : undefined;
  }
}
