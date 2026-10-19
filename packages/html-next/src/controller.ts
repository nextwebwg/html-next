import { fail } from "./diagnostics.js";
import type { ComponentGraphNode } from "./graph.js";
import type { ComponentHost } from "./runtime.js";
import type { Connect } from "./module-connection.js";
export { activateModule, type ConnectionContext, type Connect } from "./module-connection.js";

/** A component controller invoked with the instance's lifecycle-owned host. */
export type Controller = (
  host: ComponentHost,
) => void | (() => void) | Promise<void | (() => void)>;
export type ModuleImporter = (url: string) => Promise<unknown>;
export interface ControllerModule {
  readonly default: Controller;
  readonly [name: string]: unknown;
}

export interface ComponentModule {
  readonly connect?: Connect<ComponentHost>;
  readonly [name: string]: unknown;
}

const controllerModules = new Map<string, Promise<ControllerModule>>();
const componentModules = new Map<string, Promise<ComponentModule>>();

/** Loads a component's named exports without invoking browser behavior or data producers. */
export function loadComponentModule(
  node: ComponentGraphNode,
  importer: ModuleImporter = url => import(url),
): Promise<ComponentModule> {
  const edge = node.module;
  if (edge === undefined) return Promise.reject(new TypeError(`<${node.definition.contract.tag}> does not declare a module.`));
  let pending = componentModules.get(edge.url);
  if (pending === undefined) {
    pending = Promise.resolve().then(() => importer(edge.url)).then(module => {
      if (module === null || typeof module !== "object") fail("HJ002", `Component module \`${edge.url}\` must provide named exports.`, node.url);
      const candidate = module as Record<string, unknown>;
      if (candidate.connect !== undefined && typeof candidate.connect !== "function") {
        fail("HJ002", `Component module \`${edge.url}\` export \`connect\` must be a function.`, node.url);
      }
      return candidate as ComponentModule;
    }).catch((error: unknown) => {
      if (error instanceof Error && "diagnostic" in error) throw error;
      fail("HJ001", `Component module \`${edge.url}\` failed to load: ${error instanceof Error ? error.message : String(error)}.`, node.url);
    });
    componentModules.set(edge.url, pending);
  }
  return pending;
}

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
  componentModules.clear();
}
