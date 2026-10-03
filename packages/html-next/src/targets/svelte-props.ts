/** Target-neutral typed-prop rules, emitted only for Svelte components with props. */
import type { GeneratedArtifact } from "../generate.js";
import { typedPropsModule } from "./vue-props.js";
import { DECLARED_EVENT_TYPE_SOURCE, DECLARED_REFERENCE_TYPE_SOURCE } from "./shared-generated.js";

export function sveltePropsArtifact(version: string): GeneratedArtifact {
  return Object.freeze({ path: "svelte/props.ts", content: typedPropsModule(version) + DECLARED_EVENT_TYPE_SOURCE + DECLARED_REFERENCE_TYPE_SOURCE });
}
