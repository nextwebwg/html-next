/** Types for the example's build-time graph pre-compiler, which ships as plain JavaScript. */

/** Resolves the component graph rooted at `entryPath` into a browser entry module's source. */
export function precompileGraph(entryPath: string, publicRoot?: string): Promise<string>;

/** Vite plugin exposing that module as `virtual:pantry`. */
export function pantryPrecompile(entryPath: string): {
  readonly name: string;
  resolveId(source: string): string | undefined;
  load(resolved: string): Promise<string> | undefined;
};
