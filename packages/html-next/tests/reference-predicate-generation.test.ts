import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, transform } from "esbuild";
import { it } from "vitest";

it("preserves generated scalar and event checks when the compiler is bundled and minified", async () => {
  const directory = await mkdtemp(join(tmpdir(), "html-next-predicates-"));
  try {
    const compiler = createRequire(import.meta.url).resolve("typescript-compiler");
    const outfile = join(directory, "compiler.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../src/targets/vue-lowering.ts", import.meta.url))],
      outfile, bundle: true, minify: true, platform: "node", format: "esm",
      alias: { "typescript-compiler": compiler }, external: [compiler],
    });
    const generator = await import(/* @vite-ignore */ pathToFileURL(outfile).href) as { expressionHelpersSource(): string };
    const helpers = generator.expressionHelpersSource();
    const generated = await transform(`${helpers}
      export function run() {
        return [emailFormat("a@b"), emailFormat("invalid"), datetimeFormat("2026-11-05T13:45Z"),
          datetimeLocalFormat("2026-11-05T13:45"), colorFormat("rebeccapurple"), colorFormat("rgb(1 2 3)"),
          colorFormat("invalid"), referenceEvent(new Event("test")), referenceEvent({ type: "test" })];
      }`, { loader: "ts", format: "cjs" });
    const module = { exports: {} as { run(): unknown } };
    new Function("module", "exports", generated.code)(module, module.exports);
    assert.deepEqual(module.exports.run(), [true, false, true, true, true, true, false, true, false]);
    await writeFile(join(directory, "checks.ts"), helpers);
    await writeFile(join(directory, "keyword.ts"), 'export { keywordFormat } from "./checks";');
    const keyword = await build({ entryPoints: [join(directory, "keyword.ts")], bundle: true, minify: true, write: false, format: "cjs" });
    const code = keyword.outputFiles[0]!.text;
    assert.doesNotMatch(code, /rebeccapurple|WeakMap|TrustedHTML|Event/);
    const keywordModule = { exports: {} as { keywordFormat(value: string): boolean } };
    new Function("module", "exports", code)(keywordModule, keywordModule.exports);
    assert.equal(keywordModule.exports.keywordFormat("size-2"), true);
    assert.equal(keywordModule.exports.keywordFormat("two words"), false);
  } finally { await rm(directory, { recursive: true }); }
});
