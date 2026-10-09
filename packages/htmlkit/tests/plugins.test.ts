import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { withPlugins } from "../src/config.js";
import { buildApplication, createApplication, devApplication, type HtmlKitPlugin, type NavigationItem, type NavigationQuery } from "../src/index.js";
import { write } from "./fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

// A minimal page plugin: .note files are HTML Next page bodies whose @href() and @asset() references
// resolve through HTMLKit. Its config() mounts one directory at two prefixes and supplies the layout.
function notes(root: string): HtmlKitPlugin {
  return {
    name: "notes",
    config: () => ({ headScript: "window.notes = true;", pages: [{ dir: "docs", prefix: "/v/one/" }, { dir: "docs" }],
      layout: { component: join(root, "plugin/shell.html"), server: { async load({ navigation }: { navigation: (query?: NavigationQuery) => Promise<readonly NavigationItem[]> }) {
        const items = await navigation({ from: "/v/one/" });
        return { props: { links: items.map(item => item.label + (item.current === "page" ? "*" : "")).join(", ") } };
      } } } }),
    pages: { extensions: [".note"], compile(source, page) {
      const tag = "page-note-" + createHash("sha256").update(page.file).digest("hex").slice(0, 12);
      const body = source.replace(/@href\(([^)]+)\)/g, (_, target: string) => page.href(resolve(dirname(page.file), target)) ?? "missing")
        .replace(/@asset\(([^)]+)\)/g, (_, file: string) => page.asset(resolve(dirname(page.file), file)));
      return `<template component="${tag}">${body}</template>`;
    } },
  };
}

async function site() {
  const root = await mkdtemp(join(tmpdir(), "htmlkit-plugins-")); roots.push(root);
  await write(root, "package.json", '{"type":"module"}');
  await write(root, "plugin/shell.html", '<template component="notes-shell"><defs><prop name="links" type="string" required>Links</prop></defs><main><nav>{$links}</nav><slot name="page"></slot></main></template>');
  await write(root, "docs/01.index.note", '<title>Home</title><meta name="hk:label" content="Home"><article>Home body</article>');
  await write(root, "docs/02.install.note", '<title>Install</title><meta name="hk:label" content="Installing"><meta name="hk:alias" content="/start/"><article><a href="@href(01.index.note)">Back</a> <img src="@asset(mark.svg)" alt="Mark"> Install body</article>');
  await write(root, "docs/03.hidden.note", '<meta name="hk:navigation" content="hidden"><article>Hidden body</article>');
  await write(root, "docs/mark.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
  return root;
}

it("routes plugin pages through page directories, metadata, aliases, and a plugin layout", async () => {
  const root = await site();
  const application = await createApplication({ root, plugins: [notes(root)] });
  try {
    expect(application.routes.map(route => route.pattern).sort()).toEqual(["/", "/hidden/", "/install/", "/start/", "/v/one/", "/v/one/hidden/", "/v/one/install/", "/v/one/start/"]);
    const install = (await application.render("/v/one/install/")).html;
    expect(install).toContain("<nav>Home, Installing*</nav>");
    expect(install).toContain("<script>window.notes = true;</script>");
    // Links resolve to the first directory that serves the target; referenced files get stable URLs.
    expect(install).toContain('href="/v/one/"');
    expect(install).toMatch(/src="\/_htmlkit\/files\/[0-9a-f]{16}-mark\.svg"/);
    expect([...application.files.values()]).toEqual([await realpath(join(root, "docs/mark.svg"))]);
    // An alias renders its page and marks the page's own navigation entry current.
    const alias = (await application.render("/v/one/start/")).html;
    expect(alias).toContain("Install body");
    expect(alias).toContain("<nav>Home, Installing*</nav>");
    expect((await application.render("/hidden/")).html).toContain("Hidden body");
  } finally { await application.close(); }
}, 60_000);

it("keeps head scripts apart, refuses private files, and lays out an alias like its page", async () => {
  const root = await site();
  // Each script is its own element: joined, ASI would call the plugin's last expression with this one.
  await write(root, "app/head.js", "(() => { document.documentElement.dataset.user = 'yes'; })();");
  await write(root, "app/layouts/guide.html", '<template component="guide-shell"><main>Guide<slot name="page"></slot></main></template>');
  const application = await createApplication({ root, plugins: [notes(root)], layoutDefaults: { "/install/": "guide" } });
  try {
    expect((await application.render("/install/")).html).toContain("<script>window.notes = true;</script><script>(() => {");
    expect((await application.render("/install/")).html).toContain('data-component="guide-shell"');
    expect((await application.render("/start/")).html).toContain('data-component="guide-shell"');
  } finally { await application.close(); }
  for (const secret of [".env", ".git/config", "docs/server.pem"]) {
    await write(root, secret, "SECRET=1");
    await write(root, "docs/04-secret.note", `<article><img src="@asset(${join(root, secret)})" alt=""></article>`);
    await expect(createApplication({ root, plugins: [notes(root)] })).rejects.toThrow(/private/);
  }
}, 60_000);

it("serves a page-wide stylesheet from outside the root in development", async () => {
  const root = await site();
  // A plugin's own stylesheet lives in its package, outside the site's root.
  const outside = await mkdtemp(join(tmpdir(), "htmlkit-theme-")); roots.push(outside);
  await write(outside, "theme.css", "html { color: rgb(1, 2, 3); }");
  const server = await devApplication({ root, port: 0, plugins: [notes(root)], css: [join(outside, "theme.css")] });
  try {
    const html = await (await fetch(server.url + "v/one/install/")).text();
    const href = /<link rel="stylesheet" href="([^"]*theme\.css)"/.exec(html)![1]!;
    expect((await fetch(new URL(href, server.url))).status).toBe(200);
  } finally { await server.close(); }
}, 60_000);

it("serves plugin page files and recompiles edited pages in development", async () => {
  const root = await site();
  const server = await devApplication({ root, port: 0, plugins: [notes(root)] });
  try {
    const html = await (await fetch(server.url + "v/one/install/")).text();
    const image = await fetch(new URL(/src="([^"]+mark\.svg)"/.exec(html)![1]!, server.url));
    expect([image.status, image.headers.get("content-type")]).toEqual([200, "image/svg+xml"]);
    await write(root, "docs/02.install.note", '<title>Install</title><meta name="hk:label" content="Installing"><article>Edited body</article>');
    await expect.poll(async () => (await fetch(server.url + "v/one/install/")).text(), { timeout: 10_000 }).toContain("Edited body");
  } finally { await server.close(); }
}, 60_000);

it("builds plugin pages with the files they reference", async () => {
  const root = await site();
  const result = await buildApplication({ root, plugins: [notes(root)] });
  expect(result.routes).toContain("/v/one/start/");
  const [file] = await readdir(join(result.outDir, "_htmlkit/files"));
  expect(file).toMatch(/^[0-9a-f]{16}-mark\.svg$/);
  expect(await readFile(join(result.outDir, "v/one/install/index.html"), "utf8")).toContain(`/_htmlkit/files/${file}`);
}, 60_000);

it("adds a plugin's page folders, stylesheets, and folder layout to the site's own", async () => {
  const root = await site();
  await write(root, "app/pages/about.html", '<template component="page-about"><h1>About</h1></template>');
  await write(root, "app/layouts/default.html", '<template component="site-shell"><main class="site"><slot name="page"></slot></main></template>');
  const shell = { component: join(root, "plugin/shell.html"), server: { load: () => ({ props: { links: "Docs" } }) } };
  const docs: HtmlKitPlugin = { ...notes(root), config: () => ({ pages: [{ dir: "docs", prefix: "/docs/", layout: shell }], css: ["plugin/docs.css"] }) };
  const options = await withPlugins({ root, css: ["@/styles/site.css"], plugins: [docs] });
  expect(options.css).toEqual(["@/styles/site.css", "plugin/docs.css"]);
  expect(options.pages?.map(page => page.dir)).toEqual(["app/pages", "docs"]);
  const application = await createApplication(options);
  try {
    expect(application.routes.map(route => route.pattern).sort()).toEqual(["/about/", "/docs/", "/docs/hidden/", "/docs/install/", "/docs/start/"]);
    // The site's page keeps the site's default layout; the plugin's pages get the folder's layout.
    expect((await application.render("/about/")).html).toContain('data-component="site-shell"');
    const install = (await application.render("/docs/install/")).html;
    expect(install).toContain('data-component="notes-shell"');
    expect(install).not.toContain('data-component="site-shell"');
  } finally { await application.close(); }
}, 60_000);
