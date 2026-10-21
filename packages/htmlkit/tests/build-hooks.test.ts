import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { basename, extname } from "node:path";
import { buildApplication, createApplication, devApplication, previewApplication, readManifest, startApplication, type BuildEndContext, type BuildStartContext, type HtmlKitPlugin } from "../src/index.js";
import { write } from "./fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function site(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "htmlkit-hooks-")); roots.push(root);
  await write(root, "package.json", '{"type":"module"}');
  await write(root, "app/pages/index.html", '<template component="home-page"><defs><title>Home</title></defs><h1>Home</h1></template>');
  await write(root, "public/robots.txt", "User-agent: *\n");
  return root;
}

// A generator: buildStart writes a page before HTMLKit reads app/pages.
const generator = (calls: BuildStartContext[]): HtmlKitPlugin => ({
  name: "api-generator",
  async buildStart(context) {
    calls.push(context);
    await write(context.root, "app/pages/api.html", `<template component="api-page"><defs><title>API</title></defs><h1>Generated for ${context.command}</h1></template>`);
  },
});

it("runs buildStart before rendering and lets buildEnd add files to the staged output", async () => {
  const root = await site();
  const starts: BuildStartContext[] = [];
  let seen: Omit<BuildEndContext, "writeFile"> | undefined;
  const refusals: string[] = [];
  const sitemap: HtmlKitPlugin = {
    name: "sitemap",
    async buildEnd(context) {
      seen = context;
      // The manifest is already in the staged output, which is not yet outDir.
      expect((await readManifest(context.outDir)).routes).toEqual(context.pages);
      await context.writeFile("sitemap.txt", context.pages.join("\n"));
      await context.writeFile("search/index.json", new TextEncoder().encode("[]"));
      for (const path of ["index.html", "robots.txt", "404.html", "sitemap.txt", "_htmlkit/extra.json", "../escape.txt", join(root, "absolute.txt")]) {
        await context.writeFile(path, "x").catch((error: Error) => { refusals.push(error.message); });
      }
    },
  };
  const result = await buildApplication({ root, base: "/docs/", plugins: [generator(starts), sitemap] });
  expect(starts).toEqual([{ command: "build", root, base: "/docs/" }]);
  expect(await readFile(join(result.outDir, "api/index.html"), "utf8")).toContain("Generated for build");
  expect(seen?.outDir).not.toBe(result.outDir);
  expect(seen?.root).toBe(root);
  expect(seen?.base).toBe("/docs/");
  expect(seen?.pages).toEqual(["/docs/", "/docs/api/"]);
  expect(seen?.routes.map(route => route.pageName).sort()).toEqual(["api-page", "home-page"]);
  expect(await readFile(join(result.outDir, "sitemap.txt"), "utf8")).toBe("/docs/\n/docs/api/");
  expect(await readFile(join(result.outDir, "search/index.json"), "utf8")).toBe("[]");
  // Generated pages, public assets, and the hook's own files are never replaced; paths stay inside the output.
  expect(refusals).toHaveLength(7);
  expect(refusals.slice(0, 4).every(message => message.includes("Output collision"))).toBe(true);
  expect(refusals[4]).toContain("reserved");
  expect(refusals.slice(5).every(message => message.includes("inside the output"))).toBe(true);
  expect(await readFile(join(result.outDir, "index.html"), "utf8")).toContain(">Home</h1>");
  expect(await readFile(join(result.outDir, "robots.txt"), "utf8")).toBe("User-agent: *\n");
}, 60_000);

it("fails the build on a buildEnd error, naming the plugin, and keeps the previous output", async () => {
  const root = await site();
  const result = await buildApplication({ root });
  const before = await readFile(join(result.outDir, "index.html"), "utf8");
  await write(root, "app/pages/index.html", '<template component="home-page"><h1>Changed</h1></template>');
  const broken: HtmlKitPlugin = { name: "search-index", async buildEnd(context) { await context.writeFile("search.json", "[]"); throw new Error("index failed"); } };
  await expect(buildApplication({ root, plugins: [broken] })).rejects.toThrow("Plugin search-index failed in buildEnd: index failed");
  expect(await readFile(join(result.outDir, "index.html"), "utf8")).toBe(before);
  await expect(readFile(join(result.outDir, "search.json"))).rejects.toThrow();
  // A failing buildStart fails before anything is written.
  const early: HtmlKitPlugin = { name: "api-generator", buildStart() { throw new Error("no schema"); } };
  await expect(buildApplication({ root, plugins: [early] })).rejects.toThrow("Plugin api-generator failed in buildStart: no schema");
  expect(await readFile(join(result.outDir, "index.html"), "utf8")).toBe(before);
}, 60_000);

it("runs buildStart once when the development server starts", async () => {
  const root = await site();
  const starts: BuildStartContext[] = [];
  const server = await devApplication({ root, port: 0, plugins: [generator(starts)] });
  try {
    expect(await (await fetch(server.url + "api/")).text()).toContain("Generated for dev");
    await fetch(server.url);
    expect(starts).toEqual([{ command: "dev", root, base: "/" }]);
  } finally { await server.close(); }
}, 60_000);

it("pins the version 1 manifest format", async () => {
  const root = await site();
  await write(root, "app/pages/guide/[slug].html", '<template component="guide-page"><h1>Guide</h1></template>');
  await write(root, "app/pages/guide/[slug].server.ts", "export const entries = () => [{ slug: 'one' }];");
  const result = await buildApplication({ root, base: "/docs/" });
  const manifest = await readManifest(result.outDir);
  const page = (pathname: string, pageName: string) => ({ pathname, pageName,
    browserModule: expect.stringMatching(/^\/docs\/_htmlkit\/[^/]+\.js$/) as unknown, chunks: expect.arrayContaining([expect.stringMatching(/^\/docs\/_htmlkit\/[^/]+\.js$/)]) as unknown });
  expect(manifest).toStrictEqual({ version: 1, base: "/docs/", routes: ["/docs/", "/docs/guide/one/"],
    pages: [page("/docs/", "home-page"), page("/docs/guide/one/", "guide-page")], redirects: [], files: [] });
  expect(Object.keys(manifest)).toEqual(["version", "base", "routes", "pages", "redirects", "files"]);
  expect(manifest.pages.map(entry => Object.keys(entry))).toEqual([["pathname", "pageName", "browserModule", "chunks"], ["pathname", "pageName", "browserModule", "chunks"]]);
  await write(result.outDir, "_htmlkit/manifest.json", JSON.stringify({ ...manifest, version: 2 }));
  await expect(readManifest(result.outDir)).rejects.toThrow("Unsupported manifest version 2; this HTMLKit reads version 1.");
}, 60_000);

// A plugin that compiles .note files into pages and generates an index of their text, from what its compile calls saw.
const notes = (): HtmlKitPlugin => {
  const seen = new Map<string, string>();
  return {
    name: "notes",
    pages: { extensions: [".note"], compile(source, page) {
      seen.set(basename(page.file, extname(page.file)), source.trim());
      return `<template component="note-${basename(page.file, extname(page.file))}"><defs><title>Note</title></defs><h1>${source.trim()}</h1></template>`;
    } },
    generate: () => ({
      "/notes/index.json": JSON.stringify(Object.fromEntries([...seen].sort())),
      "/notes/feed": { contents: [...seen.values()].join("\n"), type: "text/plain; charset=utf-8" },
      "/notes/raw.bin": new Uint8Array([1, 2, 3]),
    }),
  };
};

it("generates plugin files after every page compiles: served uncached in development and regenerated after a change", async () => {
  const root = await site();
  await write(root, "app/pages/first.note", "First");
  const server = await devApplication({ root, base: "/docs/", port: 0, plugins: [notes()] });
  try {
    const index = await fetch(server.url + "notes/index.json");
    expect(index.headers.get("content-type")).toBe("application/json");
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expect(await index.json()).toEqual({ first: "First" });
    const feed = await fetch(server.url + "notes/feed");
    expect(feed.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await feed.text()).toBe("First");
    expect((await fetch(server.url + "notes/raw.bin")).headers.get("content-type")).toBe("application/octet-stream");
    expect((await fetch(server.url + "notes/index.json", { method: "POST" })).status).toBe(405);
    // An edit recompiles the pages, so the next request reads the regenerated file.
    await write(root, "app/pages/first.note", "First, edited");
    await write(root, "app/pages/second.note", "Second");
    await expect.poll(async () => (await fetch(server.url + "notes/index.json")).json(), { timeout: 10_000 }).toEqual({ first: "First, edited", second: "Second" });
  } finally { await server.close(); }
}, 60_000);

it("writes generated files into the build, lists them in the manifest, and serves them from preview and start", async () => {
  const root = await site();
  await write(root, "app/pages/first.note", "First");
  // A page linking to a generated file passes the link check.
  await write(root, "app/pages/index.html", '<template component="home-page"><defs><title>Home</title></defs><main><h1>Home</h1><a href="/docs/notes/index.json">Index</a></main></template>');
  const result = await buildApplication({ root, base: "/docs/", origin: "https://example.com", plugins: [notes()] });
  expect(await readFile(join(result.outDir, "notes/index.json"), "utf8")).toBe('{"first":"First"}');
  expect([...await readFile(join(result.outDir, "notes/raw.bin"))]).toEqual([1, 2, 3]);
  expect((await readManifest(result.outDir)).files).toEqual([{ pathname: "/docs/notes/index.json", type: "application/json" },
    { pathname: "/docs/notes/feed", type: "text/plain; charset=utf-8" }, { pathname: "/docs/notes/raw.bin", type: "application/octet-stream" }]);
  expect(await readFile(join(result.outDir, "sitemap.xml"), "utf8")).not.toContain("notes/");
  for (const serve of [previewApplication, startApplication]) {
    const server = await serve({ root, outDir: result.outDir, port: 0 });
    try {
      const feed = await fetch(server.url + "notes/feed");
      expect(feed.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await feed.text()).toBe("First");
      expect(await (await fetch(server.url + "notes/index.json")).json()).toEqual({ first: "First" });
    } finally { await server.close(); }
  }
}, 120_000);

it("rejects a generated path that a page, redirect, endpoint, public file, another plugin or HTMLKit also claims, naming the plugin", async () => {
  const plugin = (name: string, path: string, value: unknown = "x"): HtmlKitPlugin => ({ name, generate: () => ({ [path]: value as string }) });
  const cases: [readonly HtmlKitPlugin[], Record<string, unknown>, RegExp][] = [
    [[plugin("feed", "/")], {}, /Plugin feed generates \/, which is no file path/],
    [[plugin("feed", "/a/../b")], {}, /Plugin feed generates \/a\/\.\.\/b, which is no file path/],
    [[plugin("feed", "/_htmlkit/x.json")], {}, /which is in _htmlkit, reserved/],
    [[plugin("feed", "/404.html")], {}, /Plugin feed generates \/404\.html, which HTMLKit generates/],
    [[plugin("feed", "/robots.txt")], { robots: true }, /which HTMLKit generates/],
    [[plugin("feed", "/robots.txt")], {}, /which is a file in public\//],
    [[plugin("feed", "/about")], {}, /which is a page's URL/],
    [[plugin("feed", "/old")], { redirects: { "/old/": "/" } }, /which a redirect answers/],
    [[plugin("feed", "/api/items")], {}, /which an endpoint answers/],
    [[plugin("feed", "/a.json"), plugin("search", "/a.json")], {}, /Plugin search generates \/a\.json, which plugin feed also generates/],
    [[plugin("feed", "/a.json", 42)], {}, /whose value is no string, Uint8Array, or \{ contents, type \}/],
    [[{ name: "feed", generate() { throw new Error("no data"); } }], {}, /Plugin feed failed in generate: no data/],
  ];
  for (const [plugins, options, message] of cases) {
    const root = await site();
    await write(root, "app/pages/about.html", '<template component="about-page"><h1>About</h1></template>');
    await write(root, "app/api/items.server.ts", "export const GET = () => new Response('[]');");
    await expect(createApplication({ root, plugins, ...options })).rejects.toThrow(message);
  }
}, 60_000);
