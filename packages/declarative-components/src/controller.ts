import { fail } from "./diagnostics.js";
import type { ComponentGraphNode } from "./graph.js";
import type { ComponentHost } from "./runtime.js";

/** A component controller invoked with the instance's lifecycle-owned host. */
export type Controller = (
  host: ComponentHost,
) => void | (() => void) | Promise<void | (() => void)>;
export type ModuleImporter = (url: string) => Promise<unknown>;
export interface ControllerModule {
  readonly default: Controller;
  readonly [name: string]: unknown;
}

const controllerModules = new Map<string, Promise<ControllerModule>>();

/** Loads and validates a declared controller through the host's native ESM loader. */
export function loadControllerModule(
  node: ComponentGraphNode,
  importer: ModuleImporter = (url) => import(url),
): Promise<ControllerModule> {
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
      return Object.freeze({ ...(module as Record<string, unknown>), default: candidate }) as ControllerModule;
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

export async function loadController(
  node: ComponentGraphNode,
  importer: ModuleImporter = (url) => import(url),
): Promise<Controller> {
  return (await loadControllerModule(node, importer)).default;
}

/** Test/runtime boundary for documents that need an isolated native-module cache view. */
export function clearControllerCache(): void {
  controllerModules.clear();
}
