/**
 * The JavaScript each page of HTMLKit's examples ships: its browser module and every chunk it
 * imports, raw and gzip -9. Builds go to `.measure/`, which git ignores.
 */
import { readFile, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { buildDocsProof } from "../examples/docs/proof.js";
import { buildApplication } from "../src/index.js";

const work = fileURLToPath(new URL("../.measure/", import.meta.url));

/** A module and the modules it imports, by path within the output. */
async function closure(output: string, file: string, files = new Set<string>()): Promise<Set<string>> {
  if (files.has(file)) return files;
  files.add(file);
  const code = await readFile(join(output, file), "utf8");
  for (const [, specifier] of code.matchAll(/(?:\bimport|\bfrom)\s*["'](\.{1,2}\/[^"']+\.js)["']/g)) {
    await closure(output, posix.join(posix.dirname(file), specifier!), files);
  }
  return files;
}

async function report(example: string, output: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(output, "_htmlkit/manifest.json"), "utf8")) as
    { base: string; pages: readonly { pathname: string; browserModule: string }[] };
  for (const page of manifest.pages) {
    let bytes = 0;
    let gzip = 0;
    const files = await closure(output, page.browserModule.slice(manifest.base.length));
    for (const file of files) {
      const contents = await readFile(join(output, file));
      bytes += contents.byteLength;
      gzip += gzipSync(contents, { level: 9 }).byteLength;
    }
    console.log(`${example}\t${page.pathname}\t${files.size} modules\t${bytes} B\t${gzip} B gzip`);
  }
}

await rm(work, { recursive: true, force: true });
const basic = await buildApplication({ root: fileURLToPath(new URL("../examples/basic/", import.meta.url)), outDir: join(work, "basic") });
await report("basic", basic.outDir);
const docs = await buildDocsProof(join(work, "docs"), join(dirname(fileURLToPath(import.meta.url)), "../../../docs/guide"));
await report("docs", docs.outDir);
