/**
 * The bytes a navigation tree adds to each page: an 81-page site with a <hk-nav> of its
 * navigationTree() in the default layout, built by `htmlkit build`. Reports one page's document and
 * its <aside> sidebar, and the JavaScript the page ships, raw and gzip -9. The site and its output go
 * to `.measure/`, which git ignores.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { buildApplication } from "../src/index.js";

const root = fileURLToPath(new URL("../.measure/navigation/", import.meta.url));
const write = async (file: string, text: string) => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), text);
};
await rm(root, { recursive: true, force: true });
await write("package.json", '{"type":"module"}');
// The home page, then 4 groups of 2 folders of 10 pages.
await write("app/pages/index.html", '<template component="page-home"><h1>Home</h1></template>');
for (let group = 1; group <= 4; group++) for (let folder = 1; folder <= 2; folder++) for (let page = 1; page <= 10; page++) {
  const name = `${group}-${folder}-${page}`;
  await write(`app/pages/0${group}.(Group ${group})/folder-${group}-${folder}/${String(page).padStart(2, "0")}.page-${name}.html`,
    `<template component="page-${name}"><defs><title>Page ${name}</title></defs><article><h1>Page ${name}</h1><p>Body text.</p></article></template>`);
}
await write("app/layouts/default.html", `<template component="tree-shell"><defs>
  <prop name="tree" type="list(object({ label: string, current: string, depth: number, ... }))" required>Tree</prop></defs>
  <main><aside><hk-nav from:items="$tree"></hk-nav></aside><slot name="page"></slot></main></template>`);
await write("app/layouts/default.server.ts", "export const load = async ({ navigationTree }) => ({ props: { tree: await navigationTree() } });");

const outDir = join(root, "dist");
const { routes } = await buildApplication({ root, outDir });
const size = (text: string | Buffer) => `${text.length} B\t${gzipSync(text, { level: 9 }).byteLength} B gzip`;
const html = await readFile(join(outDir, "folder-2-1/page-2-1-5/index.html"), "utf8");
console.log(`pages\t${routes.length}`);
console.log(`document\t${size(html)}`);
console.log(`sidebar\t${size(/<aside>[\s\S]*<\/aside>/.exec(html)![0])}`);
// The page's module and every module it imports.
const modules = new Set<string>();
const visit = async (file: string): Promise<void> => {
  if (modules.has(file)) return;
  modules.add(file);
  for (const [, specifier] of (await readFile(join(outDir, file), "utf8")).matchAll(/(?:\bimport|\bfrom)\s*["'](\.{1,2}\/[^"']+\.js)["']/g)) {
    await visit(posix.join(posix.dirname(file), specifier!));
  }
};
for (const [, src] of html.matchAll(/<script type="module" src="\/([^"]+)"/g)) await visit(src!);
const code = Buffer.concat(await Promise.all([...modules].map(file => readFile(join(outDir, file)))));
console.log(`javascript\t${size(code)}\t${modules.size} modules`);
