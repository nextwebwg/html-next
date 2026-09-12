import { fail } from "./diagnostics.js";
import type { ComponentGraph, ComponentGraphNode } from "./graph.js";

export interface ComponentRegistryEntry {
  readonly node: ComponentGraphNode;
  readonly loadController?: () => Promise<unknown>;
}

/** A deterministic, customElements-shaped registry for validated graph entries. */
export class ComponentRegistry {
  readonly #entries = new Map<string, ComponentRegistryEntry>();
  readonly #waiters = new Map<string, Set<() => void>>();

  define(tag: string, entry: ComponentRegistryEntry): void {
    if (this.#entries.has(tag)) fail("HR001", `More than one definition declares <${tag}>.`);
    this.#entries.set(tag, Object.freeze(entry));
    for (const resolve of this.#waiters.get(tag) ?? []) resolve();
    this.#waiters.delete(tag);
  }

  get(tag: string): ComponentRegistryEntry | undefined {
    return this.#entries.get(tag);
  }

  whenDefined(tag: string): Promise<void> {
    if (this.#entries.has(tag)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(tag) ?? new Set();
      waiters.add(resolve);
      this.#waiters.set(tag, waiters);
    });
  }

  addGraph(
    graph: ComponentGraph,
    controllerLoader?: (node: ComponentGraphNode) => Promise<unknown>,
  ): void {
    for (const node of graph.nodes.values()) {
      if (node.shadowedByCustomElement) continue;
      this.define(node.definition.contract.tag, {
        node,
        ...(node.controller === undefined || controllerLoader === undefined
          ? {}
          : { loadController: () => controllerLoader(node) }),
      });
    }
  }
}
