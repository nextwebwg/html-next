import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TransformResult } from "vite";

/** Use the consumer's Angular linker for partial-Ivy dependencies in Vite client and server builds. */
export async function angularLinker(root: string): Promise<(source: string, file: string) => Promise<TransformResult>> {
  const consumer = createRequire(resolve(root, "package.json"));
  const compiler = createRequire(consumer.resolve("@angular/compiler-cli/package.json"));
  const linker = await import(pathToFileURL(compiler.resolve("@angular/compiler-cli/linker/babel")).href) as { default: unknown };
  const babel = await import(pathToFileURL(compiler.resolve("@babel/core")).href) as {
    transformAsync(source: string, options: Record<string, unknown>): Promise<{ code: string | null; map: TransformResult["map"] } | null>;
  };
  return async (source, file) => {
    const result = await babel.transformAsync(source, { filename: file.split("?")[0], configFile: false, babelrc: false,
      sourceMaps: true, plugins: [[linker.default, { linkerJitMode: false }]] });
    if (result?.code == null) throw new Error(`Angular linking produced no code for ${file}.`);
    return { code: result.code, map: result.map };
  };
}
