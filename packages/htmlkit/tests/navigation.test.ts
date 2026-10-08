import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApplication, discoverRoutes } from "../src/index.js";
import { write } from "./fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function site() {
  const root = await mkdtemp(join(tmpdir(), "htmlkit-navigation-")); roots.push(root);
  await write(root, "package.json", '{"type":"module"}');
  for (const [file, name] of [["01-index", "home"], ["01-guide/02-install", "install"], ["01-guide/10-next", "next"], ["01-guide/01-index", "guide"], ["02-api", "api"], ["about", "about"]]) {
    await write(root, `app/pages/${file}.html`, `<template component="page-${name}"><h1>${name}</h1></template>`);
  }
  return root;
}

it("strips opt-in numeric prefixes, including index, while retaining physical loader paths", async () => {
  const root = await site();
  await write(root, "app/pages/01-guide/02-install.server.ts", 'export const load = () => ({ head: { title: "Physical loader" } });');
  const literal = await discoverRoutes(root);
  expect(literal.map(route => route.pattern)).toContain("/01-guide/02-install/");
  expect(literal.map(route => route.pattern)).toContain("/01-index/");
  const application = await createApplication({ root, routeOrdering: true });
  try {
    expect(await application.entries()).toEqual(["/", "/about/", "/api/", "/guide/", "/guide/install/", "/guide/next/"]);
    expect((await application.render("/guide/install/")).head.title).toBe("Physical loader");
  } finally { await application.close(); }
});

it("diagnoses stripped collisions with both physical sources and empty slugs", async () => {
  const root = await site();
  await write(root, "app/pages/03-api.html", '<template component="page-other"><h1>Other</h1></template>');
  await expect(discoverRoutes(root, { routeOrdering: true })).rejects.toThrow(/02-api\.html.*03-api\.html/s);
  await rm(join(root, "app/pages/03-api.html"));
  await mkdir(join(root, "app/pages/04-"));
  await expect(discoverRoutes(root, { routeOrdering: true })).rejects.toThrow(/04-.*empty/i);
});

it("queries ordered concrete navigation with base URLs, aliases, depth, and current-page indication", async () => {
  const root = await site();
  await write(root, "app/pages/01-guide/[slug].html", '<template component="page-dynamic"><h1>Dynamic</h1></template>');
  await write(root, "app/pages/01-guide/[slug].server.ts", 'export const entries = () => [{ slug: "z" }, { slug: "a" }];');
  await write(root, "app/components/navigation.html", await readFile(new URL("../components/navigation.html", import.meta.url), "utf8"));
  await write(root, "app/layouts/default.html", `<link rel="component" href="../components/navigation.html">
    <template component="navigation-shell"><defs><prop name="navigation" type="list(object({ href: string, label: string, current: string, depth: number, pageName: string }))" required>Links</prop></defs>
    <main><htmlkit-navigation from:items="$navigation"></htmlkit-navigation><slot name="page"></slot></main></template>`);
  await write(root, "app/layouts/default.server.ts", 'export const load = async ({ navigation }) => ({ props: { navigation: await navigation({ from: "/guide/" }) } });');
  const application = await createApplication({ root, routeOrdering: true, base: "/kit/", routes: [{ pattern: "/alias/", component: "app/pages/02-api.html" }] });
  try {
    const items = await application.navigation({ current: "/kit/guide/install/" });
    expect(items.map(item => item.href)).toEqual(["/kit/", "/kit/guide/", "/kit/guide/install/", "/kit/guide/next/", "/kit/guide/a/", "/kit/guide/z/", "/kit/api/", "/kit/about/", "/kit/alias/"]);
    expect(items.find(item => item.href === "/kit/guide/install/")).toEqual({ href: "/kit/guide/install/", label: "install", current: "page", depth: 2, pageName: "page-install" });
    const html = (await application.render("/kit/guide/install/")).body;
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('href="/kit/guide/install/"');
    expect(html).not.toContain('href="/kit/api/"');
    expect(JSON.stringify(items)).not.toContain(root);
  } finally { await application.close(); }
});

it("omits unenumerated dynamic patterns from navigation while static builds diagnose them", async () => {
  const root = await site();
  await write(root, "app/pages/[missing].html", '<template component="page-missing"><h1>Missing</h1></template>');
  const application = await createApplication({ root, routeOrdering: true });
  try {
    expect((await application.navigation()).map(item => item.href)).not.toContain("/[missing]/");
    await expect(application.entries()).rejects.toThrow(/Static entries.*missing/);
  } finally { await application.close(); }
});
