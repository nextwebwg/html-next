import { fail } from "./diagnostics.js";
import type { ComponentGraphNode } from "./graph.js";

export type Controller = (host: unknown) => void | (() => void) | Promise<void | (() => void)>;
export type ModuleImporter = (url: string) => Promise<unknown>;

const controllerModules = new Map<string, Promise<Controller>>();

/** Loads and validates a declared controller through the host's native ESM loader. */
export function loadController(
  node: ComponentGraphNode,
  importer: ModuleImporter = (url) => import(url),
): Promise<Controller> {
  const edge = node.controller;
  if (edge === undefined) {
    return Promise.reject(
      new TypeError(`<${node.definition.contract.tag}> does not declare a controller.`),
    );
  }
  let pending = controllerModules.get(edge.url);
  if (pending === undefined) {
    pending = importer(edge.url).then((module) => {
      const candidate = (module as { default?: unknown } | null)?.default;
      if (typeof candidate !== "function") {
        fail("HJ002", `Controller module \`${edge.url}\` must default-export a function.`, node.url);
      }
      return candidate as Controller;
    }).catch((error: unknown) => {
      if (error instanceof Error && "diagnostic" in error) throw error;
      fail(
        "HJ001",
        `Controller module \`${edge.url}\` failed to load: ${error instanceof Error ? error.message : String(error)}.`,
        node.url,
      );
    });
    controllerModules.set(edge.url, pending);
  }
  return pending;
}

/** Test/runtime boundary for documents that need an isolated native-module cache view. */
export function clearControllerCache(): void {
  controllerModules.clear();
}
