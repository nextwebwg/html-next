/** Copies a component's controller module and its relative imports into generated output. */
import { readFile } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript-compiler";

import type { GeneratedArtifact } from "./generate.js";

/** The controller module and its static relative imports, by file URL. */
async function readControllerGraph(sourceURL: string, files: Map<string, string>): Promise<void> {
  if (files.has(sourceURL)) return;
  const content = await readFile(fileURLToPath(sourceURL), "utf8");
  files.set(sourceURL, content);
  for (const item of ts.preProcessFile(content, true, true).importedFiles) {
    if (!item.fileName.startsWith(".") && !item.fileName.startsWith("/")) continue;
    await readControllerGraph(new URL(item.fileName, sourceURL).href, files);
  }
}

/** The deepest directory containing every path. */
function commonDirectory(paths: readonly string[]): string {
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
): Promise<string> {
  const files = new Map<string, string>();
  await readControllerGraph(sourceURL, files);
  const root = fileURLToPath(trustRoot);
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
    const path = target(fileURLToPath(url));
    const prior = artifacts.get(path);
    if (prior !== undefined && prior.content !== content) throw new Error(`Generated artifact collision at ${path}.`);
    artifacts.set(path, { path, content });
  }
  return target(fileURLToPath(sourceURL));
}

