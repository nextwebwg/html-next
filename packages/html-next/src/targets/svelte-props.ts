/** Target-neutral typed-prop rules, emitted only for Svelte components with props. */
import type { GeneratedArtifact } from "../generate.js";
import { typedPropsModule } from "./vue-props.js";
import { DECLARED_EVENT_TYPE_SOURCE, DECLARED_REFERENCE_TYPE_SOURCE } from "./shared-generated.js";

export function sveltePropsArtifact(version: string): GeneratedArtifact {
  return Object.freeze({ path: "svelte/props.ts", content: typedPropsModule(version) + DECLARED_EVENT_TYPE_SOURCE + DECLARED_REFERENCE_TYPE_SOURCE + `
/** Retain the input handle when a two-way destination rejects a parent write. */
export function retainedBindingInput(): (read: (() => unknown) | undefined, initial: unknown, type: Parameters<typeof acceptsBindingDestination>[1]) => unknown {
  let initialized = false;
  let previous: unknown;
  return (read, initial, type) => {
    if (read === undefined) { initialized = false; return initial; }
    const candidate = read();
    if (candidate !== Symbol.for("html-next.invalid-result") && acceptsBindingDestination(candidate, type)) {
      previous = candidate;
      initialized = true;
    }
    return initialized ? previous : initial;
  };
}
` });
}
