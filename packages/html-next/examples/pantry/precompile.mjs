// Build-time half of the pre-compiled delivery. It resolves the same component graph the live
// page would resolve in the browser, then emits a module holding the already-parsed definitions
// and static controller imports. The browser bundle therefore contains no component parser.
//
// The shipped `@nextwebwg/html-next-unplugin` compiles components all the way to
// native DOM factories, which is smaller still, but it cannot yet express this app: compiled
// invocations carry no attributes or projected children (HN009), and a component using the
// general runtime cannot contain them at all (HN003). Until that lands, a build integration
// pre-parses the graph and keeps the general runtime renderer, which is what this file does.
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildComponentGraph, ResourceResolver } from "@nextwebwg/html-next";

/**
 * Resolves `entryPath`'s component graph and returns the source of a browser entry module.
 *
 * `publicRoot` is the directory the site serves. Each definition records where it came from, and
 * declared `<data src>` values resolve against it, so build-time file paths are rewritten to the
 * paths the browser will actually see.
 */
export async function precompileGraph(entryPath, publicRoot = resolve(dirname(entryPath), "..")) {
  const entryURL = pathToFileURL(entryPath).href;
  const graph = await buildComponentGraph([entryURL], {
    resolver: new ResourceResolver({}, entryURL),
    fetchComponent: async (url) => ({ url, source: await readFile(new URL(url), "utf8") }),
  });

  const publicPath = (url) => `/${relative(publicRoot, fileURLToPath(url)).split("\\").join("/")}`;
  const definitions = [];
  const imports = [];
  const controllers = [];
  for (const node of graph.nodes.values()) {
    definitions.push({ ...node.definition, source: { ...node.definition.source, file: publicPath(node.url) } });
    if (node.controller === undefined) continue;
    const alias = `controller${controllers.length}`;
    imports.push(`import * as ${alias} from ${JSON.stringify(new URL(node.controller.url).pathname)};`);
    controllers.push(`  ${JSON.stringify(node.definition.contract.tag)}: ${alias},`);
  }

  return [
    'import { getComponentHost, observeDocument, registerComponentDefinitions, setControllerModule }',
    '  from "@nextwebwg/html-next/runtime";',
    ...imports,
    "",
    `const definitions = ${JSON.stringify(definitions)};`,
    `const controllers = {\n${controllers.join("\n")}\n};`,
    "",
    "export function start(root = document) {",
    "  registerComponentDefinitions(definitions, root);",
    "  return observeDocument(root, {",
    "    onConnect(element, definition) {",
    "      const module = controllers[definition.contract.tag];",
    "      if (module === undefined) return;",
    "      // Declared public methods resolve through the whole module, so hand over all exports.",
    "      setControllerModule(element, Promise.resolve(module));",
    "      let disposed = false;",
    "      let cleanup;",
    "      Promise.resolve(module.default(getComponentHost(element))).then((value) => {",
    "        if (typeof value !== 'function') return;",
    "        if (disposed) value();",
    "        else cleanup = value;",
    "      });",
    "      return () => { disposed = true; cleanup?.(); };",
    "    },",
    "  });",
    "}",
    "",
  ].join("\n");
}

/** Vite plugin exposing that module as `virtual:pantry`. */
export function pantryPrecompile(entryPath) {
  const id = "virtual:pantry";
  return {
    name: "pantry-precompile",
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load: (resolved) => (resolved === `\0${id}` ? precompileGraph(entryPath) : undefined),
  };
}
