import { createRequire } from "node:module";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
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

it("orders and labels (group) folders in navigation without adding a URL segment", async () => {
  const root = await site();
  for (const [file, name] of [["docs/index", "docs"], ["docs/faq", "faq"], ["docs/02.(Reference)/api", "reference-api"],
    ["docs/01.(Getting started)/02.setup", "setup"], ["docs/01.(Getting started)/01.intro", "intro"], ["docs/01.(Getting started)/(Advanced)/tuning", "tuning"]]) {
    await write(root, `app/pages/${file}.html`, `<template component="page-${name}"><h1>${name}</h1></template>`);
  }
  // A group's _layout.html wraps its pages like any folder's.
  await write(root, "app/pages/docs/01.(Getting started)/_layout.html", '<template component="start-shell"><section><slot name="page"></slot></section></template>');
  await write(root, "app/layouts/default.html", `<template component="group-shell"><defs><prop name="pages" type="list(object({ href: string, label: string, current: string, depth: number, pageName: string, ... }))" required>Links</prop></defs>
    <main><hk-nav from:items="$pages"></hk-nav><slot name="page"></slot></main></template>`);
  await write(root, "app/layouts/default.server.ts", 'export const load = async ({ navigation }) => ({ props: { pages: await navigation({ from: "/docs/" }) } });');
  const application = await createApplication({ root });
  try {
    const intro = application.routes.find(route => route.pageName === "page-intro")!;
    expect([intro.pattern, intro.groups]).toEqual(["/docs/intro/", [{ label: "Getting started", order: "01", depth: 1 }]]);
    expect(application.routes.find(route => route.pageName === "page-tuning")!.groups!.map(group => group.label)).toEqual(["Getting started", "Advanced"]);
    const items = await application.navigation({ from: "/docs/" });
    expect(items.map(item => [item.href, item.group])).toEqual([["/docs/", undefined], ["/docs/intro/", "Getting started"], ["/docs/setup/", "Getting started"],
      ["/docs/tuning/", "Advanced"], ["/docs/api/", "Reference"], ["/docs/faq/", undefined]]);
    expect(Object.keys(items[0]!)).not.toContain("group");
    const { body } = await application.render("/docs/intro/");
    expect(body).toContain('data-component="start-shell"');
    // <hk-nav> labels each group where its pages start.
    expect([...body.matchAll(/<li data-group[^>]*>([^<]+)<\/li>/g)].map(match => match[1])).toEqual(["Getting started", "Advanced", "Reference"]);
    expect(body.replace(/<!--[^>]*-->/g, "").replace(/>\s+</g, "><")).toContain('<li data-group="" data-depth="1">Getting started</li><li data-depth="1"><a href="/docs/intro/" aria-current="page">intro</a></li>');
    expect((await application.render("/docs/faq/")).body).not.toContain("start-shell");
  } finally { await application.close(); }
  await mkdir(join(root, "app/pages/docs/03.( )"));
  await expect(discoverRoutes(root)).rejects.toThrow(/route group needs a label/);
});

it("orders a page by hk:order in place of its number-and-dot prefix", async () => {
  const root = await site();
  // 10.next.html would follow 02.install.html; hk:order 1 puts it first, and about joins the numbered pages.
  await write(root, "app/pages/01.guide/10.next.html", '<template component="page-next"><meta name="hk:order" content="1"><h1>next</h1></template>');
  await write(root, "app/pages/about.html", '<template component="page-about"><meta name="hk:order" content="3"><h1>about</h1></template>');
  const application = await createApplication({ root });
  try {
    expect((await application.navigation()).map(item => item.href)).toEqual(["/", "/guide/", "/guide/next/", "/guide/install/", "/api/", "/about/"]);
    expect(application.routes.find(route => route.pageName === "page-next")!.order).toEqual(["01", "1"]);
  } finally { await application.close(); }
  await write(root, "app/pages/about.html", '<template component="page-about"><meta name="hk:order" content="first"><h1>about</h1></template>');
  await expect(discoverRoutes(root)).rejects.toThrow(/hk:order needs a whole number/);
  await write(root, "app/pages/about.html", '<template component="page-about"><h1>about</h1></template>');
  // On a folder's index page, hk:order orders the folder, with its pages, among its neighbours.
  await write(root, "app/pages/01.guide/01.index.html", '<template component="page-guide"><meta name="hk:order" content="5"><h1>guide</h1></template>');
  const reordered = await createApplication({ root });
  try {
    expect((await reordered.navigation()).map(item => item.href)).toEqual(["/", "/api/", "/guide/", "/guide/next/", "/guide/install/", "/about/"]);
    expect((await reordered.navigationTree()).map(node => [node.href, node.order])).toEqual([["/", null], ["/api/", "02"], ["/guide/", "5"], ["/about/", null]]);
  } finally { await reordered.close(); }
  await write(root, "app/pages/01.index.html", '<template component="page-home"><meta name="hk:order" content="2"><h1>home</h1></template>');
  await expect(discoverRoutes(root)).rejects.toThrow(/01\.index\.html: hk:order on the site's home page has no folder to order/);
});

it("nests navigation by folder and group, labels folders from their index pages, and renders <details> in <hk-nav>", async () => {
  const root = await site();
  // A folder's index page labels it by hk:label, then by its <title>.
  await write(root, "app/pages/01.guide/01.index.html", '<template component="page-guide"><title>The guide</title><h1>guide</h1></template>');
  await write(root, "app/pages/01.guide/20.(Advanced)/tuning.html", '<template component="page-tuning"><h1>tuning</h1></template>');
  await write(root, "app/pages/01.guide/deep/more.html", '<template component="page-more"><h1>more</h1></template>');
  await write(root, "app/layouts/default.html", `<template component="tree-shell"><defs>
    <prop name="tree" type="list(object({ label: string, current: string, depth: number, ... }))" required>Tree</prop>
    <prop name="previous" type="object({ href: string, label: string, current: string, depth: number, pageName: string, ... })" nullable>Previous</prop>
    <prop name="next" type="object({ href: string, label: string, current: string, depth: number, pageName: string, ... })" nullable>Next</prop></defs>
    <main><hk-nav from:items="$tree"></hk-nav><slot name="page"></slot><hk-pager from:previous="$previous" from:next="$next"></hk-pager></main></template>`);
  await write(root, "app/layouts/default.server.ts", 'export const load = async ({ navigationTree, pager }) => ({ props: { tree: await navigationTree(), ...await pager() } });');
  const application = await createApplication({ root });
  try {
    const tree = await application.navigationTree({ current: "/guide/tuning/" });
    const shape = (nodes: typeof tree): unknown => nodes.map(node => node.children.length === 0 ? node.label : [node.label, node.open, shape(node.children)]);
    expect(shape(tree)).toEqual(["Home", ["The guide", true, ["install", "next", ["Advanced", true, ["tuning"]], ["deep", false, ["more"]]]], "api", "about"]);
    const guide = tree[1]!;
    expect({ ...guide, children: guide.children.length }).toEqual({ label: "The guide", href: "/guide/", pageName: "page-guide", current: "false", open: true, depth: 0, order: "01", children: 4 });
    // A group, and a folder without an index page, have no page of their own.
    expect(guide.children[2]).toMatchObject({ label: "Advanced", current: "false", open: true, depth: 1, order: "20" });
    expect(guide.children[2]!.href).toBeUndefined();
    expect(guide.children[2]!.children[0]).toEqual({ label: "tuning", href: "/guide/tuning/", pageName: "page-tuning", current: "page", open: true, depth: 2, order: null, children: [] });
    expect((await application.navigationTree({ from: "/guide/" })).map(node => node.label)).toEqual(["guide", "install", "next", "Advanced", "deep"]);
    // The pager moves through the same order as the tree.
    expect((await application.navigation()).map(item => item.href)).toEqual(["/", "/guide/", "/guide/install/", "/guide/next/", "/guide/tuning/", "/guide/deep/more/", "/api/", "/about/"]);
    const body = (await application.render("/guide/tuning/")).body.replace(/<!--[^>]*-->/g, "").replace(/>\s+</g, "><");
    expect(body).toContain('<details open=""><summary><a href="/guide/" aria-current="false">The guide</a></summary>');
    expect(body).toContain('<details open=""><summary><span>Advanced</span></summary>');
    expect(body).toContain('<details><summary><span>deep</span></summary><ul><li data-depth="2"><a href="/guide/deep/more/" aria-current="false">more</a></li></ul></details>');
    expect(body).toMatch(/<a rel="prev" href="\/guide\/next\/">/);
    expect(body).toMatch(/<a rel="next" href="\/guide\/deep\/more\/">/);
  } finally { await application.close(); }
});

it("renders a tree's first three levels inline in <hk-nav>, and deeper levels through <hk-nav-items>", async () => {
  const root = await site();
  await write(root, "app/pages/a/b/c/d/e/leaf.html", '<template component="page-leaf"><h1>leaf</h1></template>');
  await write(root, "app/layouts/default.html", `<template component="tree-shell"><defs>
    <prop name="tree" type="list(object({ label: string, current: string, depth: number, ... }))" required>Tree</prop></defs>
    <main><hk-nav from:items="$tree"></hk-nav><slot name="page"></slot></main></template>`);
  await write(root, "app/layouts/default.server.ts", 'export const load = async ({ navigationTree }) => ({ props: { tree: await navigationTree() } });');
  const application = await createApplication({ root });
  try {
    const body = (await application.render("/a/b/c/d/e/leaf/")).body.replace(/<!--[^>]*-->/g, "").replace(/>\s+</g, "><");
    const nav = /<nav [^>]*data-component="hk-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(body)![1]!;
    expect([...nav.matchAll(/<details open=""><summary><span>(\w)<\/span><\/summary><ul( data-component="hk-nav-items")?/g)].map(match => [match[1], match[2] !== undefined]))
      .toEqual([["a", false], ["b", false], ["c", true], ["d", true], ["e", true]]);
    expect(nav).toContain('<a href="/a/b/c/d/e/leaf/" aria-current="page">leaf</a>');
    // The tree reaches the page in <hk-nav>'s props, and each deeper instance holds only its own levels.
    expect(nav.match(/data-html-next-instance/g)).toHaveLength(3);
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
  await write(root, "app/pages/blog/[slug].html", '<template component="page-post"><p>Post</p></template>');
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
    // A dynamic page without entries() renders on request; its trail still ends at it.
    const post = /<nav aria-label="Breadcrumb"[^>]*>([\s\S]*?)<\/nav>/.exec((await application.render("/kit/blog/hello/")).body)![1]!;
    expect(post).toMatch(/<a href="\/kit\/blog\/hello\/"[^>]*aria-current="page"[^>]*>hello<\/a>/);
  } finally { await application.close(); }
});

it("names the layout whose loader's prop fails its declared type, not the head it renders", async () => {
  const root = await site();
  await write(root, "app/pages/docs/01.(Getting started)/intro.html", '<template component="page-intro"><h1>intro</h1></template>');
  // A closed object type, which a group item's extra group field does not satisfy.
  await write(root, "app/layouts/default.html", `<template component="trail-shell"><title>Docs</title><defs>
    <prop name="crumbs" type="list(object({ href: string, label: string, current: string, depth: number, pageName: string }))" required>Trail</prop></defs>
    <main><hk-breadcrumbs from:items="$crumbs"></hk-breadcrumbs><slot name="page"></slot></main></template>`);
  await write(root, "app/layouts/default.server.ts", "export const load = async ({ breadcrumbs }) => ({ props: { crumbs: await breadcrumbs() } });");
  const application = await createApplication({ root });
  try {
    await expect(application.render("/docs/intro/")).rejects.toThrow(/HC021: Prop `crumbs` of <trail-shell> does not satisfy its declared type/);
  } finally { await application.close(); }
});

it("names the removed routeOrdering option and exports every built-in component", async () => {
  const root = await mkdtemp(join(tmpdir(), "htmlkit-removed-")); roots.push(root);
  await expect(createApplication({ root, routeOrdering: true } as never)).rejects.toThrow(/routeOrdering option was removed/);
  // Package consumers link built-ins by specifier, through exports rather than HTMLKit's import map.
  const require = createRequire(import.meta.url);
  for (const file of await readdir(new URL("../components/", import.meta.url))) {
    expect(require.resolve(`@nextwebwg/htmlkit/components/${file}`).replaceAll("\\", "/")).toMatch(new RegExp(`/components/${file}$`));
  }
});
