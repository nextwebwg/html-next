import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApplication, discoverRoutes } from "../src/index.js";
import { write } from "./fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function site() {
  const root = await mkdtemp(join(tmpdir(), "hk-nav-")); roots.push(root);
  await write(root, "package.json", '{"type":"module"}');
  for (const [file, name] of [["01.index", "home"], ["01.guide/02.install", "install"], ["01.guide/10.next", "next"], ["01.guide/01.index", "guide"], ["02.api", "api"], ["about", "about"]]) {
    await write(root, `app/pages/${file}.html`, `<template component="page-${name}"><h1>${name}</h1></template>`);
  }
  return root;
}

it("orders by number-and-dot prefixes automatically, including index, while retaining physical loader paths", async () => {
  const root = await site();
  await write(root, "app/pages/01.guide/02.install.server.ts", 'export const load = () => ({ head: { title: "Physical loader" } });');
  // A dash is part of a name, never an ordering prefix.
  await write(root, "app/pages/2024-recap.html", '<template component="page-recap"><h1>Recap</h1></template>');
  const application = await createApplication({ root });
  try {
    expect(await application.entries()).toEqual(["/", "/2024-recap/", "/about/", "/api/", "/guide/", "/guide/install/", "/guide/next/"]);
    expect((await application.render("/guide/install/")).head.title).toBe("Physical loader");
  } finally { await application.close(); }
});

it("diagnoses stripped collisions with both physical sources and empty slugs", async () => {
  const root = await site();
  await write(root, "app/pages/03.api.html", '<template component="page-other"><h1>Other</h1></template>');
  await expect(discoverRoutes(root)).rejects.toThrow(/02\.api\.html.*03\.api\.html/s);
  await rm(join(root, "app/pages/03.api.html"));
  await mkdir(join(root, "app/pages/04."));
  await expect(discoverRoutes(root)).rejects.toThrow(/04\..*empty/i);
});

it("queries ordered concrete navigation with base URLs, aliases, depth, and current-page indication", async () => {
  const root = await site();
  await write(root, "app/pages/01.guide/[slug].html", '<template component="page-dynamic"><h1>Dynamic</h1></template>');
  await write(root, "app/pages/01.guide/[slug].server.ts", 'export const entries = () => [{ slug: "z" }, { slug: "a" }];');
  // <hk-nav> is built in; no component link is needed.
  await write(root, "app/layouts/default.html", `<template component="navigation-shell"><defs><prop name="navigation" type="list(object({ href: string, label: string, current: string, depth: number, pageName: string }))" required>Links</prop></defs>
    <main><hk-nav from:items="$navigation"></hk-nav><slot name="page"></slot></main></template>`);
  await write(root, "app/layouts/default.server.ts", 'export const load = async ({ navigation }) => ({ props: { navigation: await navigation({ from: "/guide/" }) } });');
  const application = await createApplication({ root, base: "/kit/", routes: [{ pattern: "/alias/", component: "app/pages/02.api.html" }] });
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
  const application = await createApplication({ root });
  try {
    expect((await application.navigation()).map(item => item.href)).not.toContain("/[missing]/");
    await expect(application.entries()).rejects.toThrow(/Static entries.*missing/);
  } finally { await application.close(); }
});

it("names the hk: spelling for metadata written with the old htmlkit: prefix", async () => {
  const root = await site();
  await write(root, "app/pages/about.html", '<template component="page-about"><meta name="htmlkit:label" content="About"><h1>about</h1></template>');
  await expect(discoverRoutes(root)).rejects.toThrow(/write hk:label instead of htmlkit:label/);
});

it("renders built-in breadcrumbs and previous/next links from navigation order", async () => {
  const root = await site();
  const item = "object({ href: string, label: string, current: string, depth: number, pageName: string })";
  await write(root, "app/layouts/default.html", `<template component="trail-shell"><defs>
    <prop name="crumbs" type="list(${item})" required>Trail</prop>
    <prop name="previous" type="${item}" nullable>Previous page</prop>
    <prop name="next" type="${item}" nullable>Next page</prop></defs>
    <main><hk-breadcrumbs from:items="$crumbs"></hk-breadcrumbs><slot name="page"></slot><hk-pager from:previous="$previous" from:next="$next"></hk-pager></main></template>`);
  await write(root, "app/layouts/default.server.ts", 'export const load = async ({ breadcrumbs, pager }) => ({ props: { crumbs: await breadcrumbs(), ...await pager() } });');
  const application = await createApplication({ root, base: "/kit/" });
  try {
    const html = (await application.render("/kit/guide/install/")).body;
    const trail = /<nav aria-label="Breadcrumb"[^>]*>([\s\S]*?)<\/nav>/.exec(html)![1]!;
    expect([...trail.matchAll(/<a href="([^"]+)"[^>]*aria-current="(\w+)"[^>]*>([^<]+)<\/a>/g)].map(match => match.slice(1))).toEqual([
      ["/kit/", "false", "Home"], ["/kit/guide/", "false", "guide"], ["/kit/guide/install/", "page", "install"]]);
    expect(html).toMatch(/<a rel="prev" href="\/kit\/guide\/"><small>Previous<\/small> guide<\/a>/);
    expect(html).toMatch(/<a rel="next" href="\/kit\/guide\/next\/"><small>Next<\/small> next<\/a>/);
    // The first page has no previous link and the last has no next.
    expect((await application.render("/kit/")).body).not.toContain('rel="prev"');
    expect((await application.render("/kit/about/")).body).not.toContain('rel="next"');
  } finally { await application.close(); }
});
