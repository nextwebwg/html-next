/** Target-neutral typed-prop rules, emitted only for Svelte components with props. */
import type { GeneratedArtifact } from "../generate.js";
import { typedPropsModule } from "./vue-props.js";

export function sveltePropsArtifact(version: string): GeneratedArtifact {
  return Object.freeze({ path: "svelte/props.ts", content: typedPropsModule(version) });
}
