import { createHash } from "node:crypto";
import { posix } from "node:path";
import ts from "typescript-compiler";
import type { ComponentDefinition } from "./template.js";

/** Recognize the binding library's exported protocol without evaluating component JavaScript. */
export async function preparedModuleRevision(controller: string, definition: ComponentDefinition, version: string,
  readSource: (path: string) => Promise<string>): Promise<{ readonly source: string } | undefined> {
  const texts = new Map<string, string>();
  const text = async (path: string): Promise<string> => {
    let value = texts.get(path);
    if (value === undefined) { value = await readSource(path); texts.set(path, value); }
    return value;
  };
  const names = new Set<string>();
  const visited = new Set<string>();
  const relative = (path: string, specifier: string): string => posix.normalize(posix.join(posix.dirname(path), specifier));
  const exported = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) exported(element.name);
  };
  const inspect = async (path: string): Promise<void> => {
    if (visited.has(path)) return;
    visited.add(path);
    const emitted = ts.transpileModule(await text(path), { fileName: path,
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
    for (const statement of ts.createSourceFile(path, emitted, ts.ScriptTarget.Latest).statements) {
      if (ts.isExportDeclaration(statement)) {
        if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) names.add(element.name.text);
        } else if (statement.exportClause === undefined && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
          && statement.moduleSpecifier.text.startsWith(".")) await inspect(relative(path, statement.moduleSpecifier.text));
      } else {
        const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
        if (!modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
          || modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) continue;
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) exported(declaration.name);
        else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined) names.add(statement.name.text);
      }
    }
  };
  await inspect(controller);
  if (!names.has("prepare") || !names.has("adopt")) return undefined;
  const hash = createHash("sha256").update(version).update(JSON.stringify(definition));
  visited.clear();
  const revision = async (path: string): Promise<void> => {
    if (visited.has(path)) return;
    visited.add(path);
    hash.update(path).update("\0").update(await text(path)).update("\0");
    for (const specifier of ts.preProcessFile(await text(path), true, true).importedFiles.map(entry => entry.fileName).sort()) {
      if (specifier.startsWith(".")) await revision(relative(path, specifier));
      else hash.update(specifier).update("\0");
    }
  };
  await revision(controller);
  return { source: hash.digest("hex") };
}

