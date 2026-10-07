/** Copies a component's controller module and its relative imports into generated output. */
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript-compiler";

import type { GeneratedArtifact } from "./generate.js";

/** The controller module and its static relative imports, by file URL. */
function within(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function assertStaticDynamicImports(sourceURL: string, content: string): void {
  const source = ts.createSourceFile(fileURLToPath(sourceURL), content, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        (node.arguments.length === 0 || !ts.isStringLiteralLike(node.arguments[0]!))) {
      throw new Error(`Controller module \`${sourceURL}\` has a dynamic import without a static string specifier; its dependency cannot be relocated.`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

async function readControllerGraph(
  sourceURL: string,
  trustRoot: string,
  canonicalRoot: string,
  files: Map<string, string>,
): Promise<void> {
  if (files.has(sourceURL)) return;
  const path = fileURLToPath(sourceURL);
  if (!within(trustRoot, path)) {
    throw new Error(`Controller module \`${sourceURL}\` is outside the component's approved root.`);
  }
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch (error) {
    throw new Error(`Controller module \`${sourceURL}\` failed to load: ${error instanceof Error ? error.message : String(error)}.`, { cause: error });
  }
  if (!within(canonicalRoot, canonicalPath)) {
    throw new Error(`Controller module \`${sourceURL}\` is outside the component's approved root.`);
  }
  const content = await readFile(canonicalPath, "utf8");
  assertStaticDynamicImports(sourceURL, content);
  files.set(sourceURL, content);
  for (const item of ts.preProcessFile(content, true, true).importedFiles) {
    if (!item.fileName.startsWith(".") && !item.fileName.startsWith("/")) continue;
    await readControllerGraph(new URL(item.fileName, sourceURL).href, trustRoot, canonicalRoot, files);
  }
}

/** The deepest directory containing every path. */
export function commonDirectory(paths: readonly string[]): string {
  let common = dirname(paths[0]!);
  for (const path of paths.slice(1)) {
    while (relative(common, path).startsWith(`..${sep}`)) common = dirname(common);
  }
  return common;
}

/**
 * Copies a controller and its relative imports under `targetRoot`, named relative to the deepest
 * directory that holds the whole graph: the component's own directory unless the controller imports
 * a shared module beside it. The graph must stay inside the component's package (`trustRoot`).
 */
export async function addControllerGraph(
  sourceURL: string,
  trustRoot: string,
  targetRoot: string,
  artifacts: Map<string, GeneratedArtifact>,
  sourceFiles?: Set<string>,
): Promise<string> {
  const files = new Map<string, string>();
  const root = fileURLToPath(trustRoot);
  const canonicalRoot = await realpath(root);
  await readControllerGraph(sourceURL, root, canonicalRoot, files);
  const paths = [...files.keys()].map((url) => fileURLToPath(url));
  for (const path of paths) {
    const withinRoot = relative(root, path);
    if (withinRoot === ".." || withinRoot.startsWith(`..${sep}`)) {
      throw new Error(`Controller module escaped its component root: ${path}.`);
    }
  }
  const base = commonDirectory(paths);
  const target = (path: string) => `${targetRoot}/${relative(base, path).split(sep).join("/")}`;
  for (const [url, content] of files) {
    sourceFiles?.add(fileURLToPath(url));
    const path = target(fileURLToPath(url));
    const prior = artifacts.get(path);
    if (prior !== undefined && prior.content !== content) throw new Error(`Generated artifact collision at ${path}.`);
    artifacts.set(path, { path, content });
  }
  return target(fileURLToPath(sourceURL));
}
