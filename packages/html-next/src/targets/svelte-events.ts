import type { GeneratedArtifact } from "../generate.js";
import { nativeEventsModule } from "./react-events.js";

export function svelteEventsArtifact(version: string, declared = false): GeneratedArtifact {
  return Object.freeze({ path: "svelte/events.ts", content: nativeEventsModule(version, declared) });
}
