import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, createApplication, discoverRoutes, devApplication, previewApplication } from "../src/index.js";
import { fixture, write } from "./fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function app(): Promise<string> { const root = await fixture(); roots.push(root); return root; }

describe("application platform", () => {
  it("selects one page among helpers and applies named, directory, default, and disabled layouts", async () => {
    const root = await app();
    await rm(join(root, "app/layouts/default.server.ts"));
    await write(root, "app/layouts/default.html", '<template component="default-shell"><main>Default<slot name="page"></slot></main></template>');
    await write(root, "app/layouts/admin.html", '<template component="admin-shell"><main>Admin<slot name="page"></slot></main></template>');
    await write(root, "extra/products.html", '<meta name="hk:page" content="page-products"><template component="product-label"><meta name="hk:layout" content="absent"><title>Helper title</title><strong>Helper</strong></template><template component="page-products"><meta name="hk:layout" content="admin"><title>Products</title><product-label></product-label></template>');
    await write(root, "extra/plain.html", '<template component="page-plain"><meta name="hk:layout" content="none"><p>Standalone</p></template>');
    await write(root, "extra/default.html", '<template component="page-default"><p>Content</p></template>');
    const options = { root, fileRoutes: false, layoutDefaults: { "/admin/": "admin" }, routes: [
      { pattern: "/products/", component: "extra/products.html" },
      { pattern: "/plain/", component: "extra/plain.html" },
      { pattern: "/default/", component: "extra/default.html" },
      { pattern: "/admin/", component: "extra/default.html" },
    ] };
    const application = await createApplication(options);
    try {
      expect(application.routes[0]!.pageName).toBe("page-products");
      expect((await application.render("/products/")).body).toContain('data-component="admin-shell"');
      expect((await application.render("/products/")).body).toContain("Helper");
      expect((await application.render("/products/")).head.title).toBe("Products");
      expect((await application.render("/plain/")).body).not.toContain("shell");
      expect((await application.render("/default/")).body).toContain('data-component="default-shell"');
      expect((await application.render("/admin/")).body).toContain('data-component="admin-shell"');
    } finally { await application.close(); }
    await write(root, "extra/products.html", '<template component="product-label"><p>Label</p></template><template component="page-products"><p>Page</p></template>');
    await expect(discoverRoutes(root, options)).rejects.toThrow(/hk:page/);
    await write(root, "extra/products.html", '<meta name="hk:page" content="absent-page"><template component="page-products"><p>Page</p></template>');
    await expect(discoverRoutes(root, options)).rejects.toThrow(/absent-page/);
  });

  it("renders head bindings from loader props and merges page overrides while preserving repeatable links", async () => {
    const root = await app();
    await rm(join(root, "app/layouts/default.server.ts"));
    await write(root, "app/layouts/default.html", '<template component="head-shell"><title>Site title</title><meta name="description" content="Site description"><meta property="og:title" content="Site"><link rel="canonical" href="https://example.test/"><link rel="stylesheet" href="/shared.css"><link rel="alternate" hreflang="en" href="https://example.test/en/"><main><slot name="page"></slot></main></template>');
    await write(root, "extra/head.html", '<meta name="hk:page" content="page-head"><template component="head-helper"><title>{$missing}</title><meta name="hk:layout" content="absent"><meta name="description" content="Helper description"><meta property="og:image" content="https://example.test/helper.png"><strong>Helper content</strong></template><template component="page-head"><title>{$title}</title><meta name="description" from:content="$description"><meta property="og:title" from:content="$title"><meta property="og:image" content="https://example.test/a.png"><meta property="og:image" content="https://example.test/b.png"><link rel="canonical" from:href="$canonical"><link rel="stylesheet" href="/page.css"><link rel="alternate" hreflang="fr" href="https://example.test/fr/"><defs><prop name="title" type="string" required>Title</prop><prop name="description" type="string" required>Description</prop><prop name="canonical" type="string" required>Canonical</prop></defs><section><p>{$title}</p><head-helper></head-helper></section></template>');
    await write(root, "extra/head.server.ts", 'export const load = () => ({ props: { title: "Page & title", description: "a < b", canonical: "https://example.test/page/" } });');
    const application = await createApplication({ root, fileRoutes: false, routes: [{ pattern: "/", component: "extra/head.html", server: "extra/head.server.ts" }] });
    try {
      const { html } = await application.render("/");
      const head = html.split("<head>")[1]!.split("</head>")[0]!;
      expect(head).toContain("<title>Page &amp; title</title>");
      expect(head).toContain('name="description" content="a &lt; b"');
      expect(head).toContain('property="og:title" content="Page &amp; title"');
      expect(head).toContain('href="https://example.test/page/"');
      expect(head).not.toContain("Site description");
      expect(head.match(/rel="canonical"/g)).toHaveLength(1);
      for (const value of ["/shared.css", "/page.css", 'hreflang="en"', 'hreflang="fr"', "a.png", "b.png"]) expect(head).toContain(value);
      expect(head).not.toMatch(/hk:|from:|\{\$/);
      expect(head).not.toContain("Helper description");
      expect(head).not.toContain("helper.png");
      expect(html.split("</head>")[1]).toContain("Helper content");
    } finally { await application.close(); }
  });
  it("inlines app/head.js before stylesheets and rejects text that would end its script", async () => {
    const prepaint = "<script>document.documentElement.dataset.prepaint = String(document.body === null);</script>";
    const root = await app();
    await write(root, "app/layouts/default.html", '<template component="app-layout"><link rel="stylesheet" href="/shared.css"><main><slot name="page"></slot></main></template>');
    await write(root, "app/layouts/default.server.ts", 'export const load = () => ({ head: { title: "Loaded", script: "injected()" } });');
    const application = await createApplication({ root });
    try {
      const { html } = await application.render("/");
      expect(html).toContain('<head><meta charset="utf-8"><script>document.documentElement.dataset.prepaint = String(document.body === null);</script><meta name="viewport"');
      expect(html.indexOf("<script>")).toBeLessThan(html.indexOf("/shared.css"));
      // The not-found page gets it too, rendered and built, so a saved theme never flashes there.
      expect((await application.render("/missing/")).html).toContain(prepaint);
    } finally { await application.close(); }
    await buildApplication({ root });
    expect(await readFile(join(root, "dist/404.html"), "utf8")).toContain(prepaint);
    await write(root, "app/head.js", 'console.log("</SCRIPT>");');
    await expect(createApplication({ root })).rejects.toThrow("app/head.js cannot contain");
    // Without app/head.js, a loader's untyped head fields still cannot add a script.
    await rm(join(root, "app/head.js"));
    const unscripted = await createApplication({ root });
    try {
      const { html } = await unscripted.render("/");
      expect(html).toContain("<title>Home &amp; kit</title>");
      expect(html).not.toContain("injected()");
    } finally { await unscripted.close(); }
  }, 60_000);

  it("serves rendered pages for native Requests through application.fetch", async () => {
    const root = await app();
    const application = await createApplication({ root });
    try {
      // Unbound, as runtimes receive it: Deno.serve(application.fetch).
      const { fetch: handle } = application;
      const home = await handle(new Request("http://localhost/"));
      expect([home.status, home.headers.get("content-type")]).toEqual([200, "text/html; charset=utf-8"]);
      const html = await home.text();
      expect(html).toContain("<title>Home &amp; kit</title>");
      expect(html).toContain("<script>document.documentElement.dataset.prepaint");
      expect(html).not.toContain("@vite/client");
      expect(await (await handle(new Request("http://localhost/", { method: "HEAD" }))).text()).toBe("");
      const redirect = await handle(new Request("http://localhost/items/one?query"));
      expect([redirect.status, redirect.headers.get("location")]).toEqual([308, "/items/one/"]);
      expect(await (await handle(new Request("http://localhost/items/one/"))).text()).toContain("kit: one");
      expect((await handle(new Request("http://localhost/missing/"))).status).toBe(404);
      // A leading // would name another origin; it is simply not a page here.
      expect((await handle(new Request("http://localhost//evil.example/"))).status).toBe(404);
      const post = await handle(new Request("http://localhost/", { method: "POST" }));
      expect([post.status, post.headers.get("allow")]).toEqual([405, "GET, HEAD"]);
    } finally { await application.close(); }
  }, 60_000);

  it("resolves @/ from the project root and links built-in components without a link", async () => {
    const root = await mkdtemp(join(tmpdir(), "htmlkit-alias-")); roots.push(root);
    await write(root, "package.json", '{"type":"module"}');
    await write(root, "components/card.html", '<template component="app-card" controller="@/controllers/card.ts"><p>Card</p><style>@import "@/styles/card.css";</style></template>');
    await write(root, "controllers/card.ts", "export default function (host) { host.root.dataset.card = 'ready'; }");
    await write(root, "styles/card.css", "p { color: rgb(1, 2, 3); }");
    await write(root, "lib/title.ts", "export const title = 'From @/';");
    await write(root, "app/pages/index.html", '<link rel="component" href="@/components/card.html"><template component="page-home"><defs><prop name="links" type="list(object({ href: string, label: string, current: string, depth: number, pageName: string }))" required>Links</prop></defs><main><app-card></app-card><hk-nav from:items="$links"></hk-nav></main></template>');
    await write(root, "app/pages/index.server.ts", "import { title } from '@/lib/title.ts'; export const load = async ({ navigation }) => ({ props: { links: await navigation() }, head: { title } });");
    const application = await createApplication({ root });
    try {
      const { html } = await application.render("/");
      expect(html).toContain("<title>From @/</title>");
      expect(html).toContain("Card");
      expect(html).toMatch(/<nav[^>]*data-component="hk-nav"/);
    } finally { await application.close(); }
    const result = await buildApplication({ root });
    expect(result.browserInputs.some(input => input.endsWith("controllers/card.ts"))).toBe(true);
    const styles = await Promise.all((await readdir(join(result.outDir, "_htmlkit"))).filter(name => name.endsWith(".css")).map(name => readFile(join(result.outDir, "_htmlkit", name), "utf8")));
    expect(styles.join("")).toContain("#010203");
  }, 60_000);

  it("discovers routes and named layouts without importing controllers", async () => {
    const root = await app();
    const routes = await discoverRoutes(root);
    expect(routes.map(route => route.pattern)).toEqual(["/", "/items/[slug]/"]);
    expect(routes[1]!.layouts).toHaveLength(1);
  });

  it("keeps each page's metadata with its component when a file contains multiple candidate pages", async () => {
    const root = await app();
    const pages = '<template component="page-first"><meta name="hk:layout" content="none"><title>First title</title><meta name="description" content="First description"><p>First page</p></template>' +
      '<template component="page-second"><meta name="hk:layout" content="default"><title>Second title</title><meta name="description" content="Second description"><p>Second page</p></template>';
    for (const selected of ["first", "second"]) {
      await write(root, "extra/pages.html", `<meta name="hk:page" content="page-${selected}">${pages}`);
      const application = await createApplication({ root, fileRoutes: false, routes: [{ pattern: "/", component: "extra/pages.html" }] });
      try {
        const page = await application.render("/");
        expect(page.head.title).toBe(selected === "first" ? "First title" : "Second title");
        expect(page.head.description).toBe(selected === "first" ? "First description" : "Second description");
        expect(page.body.includes('data-component="app-layout"')).toBe(selected === "second");
        expect(page.body).not.toMatch(/<title|<meta/);
      } finally { await application.close(); }
    }
  });

  it("diagnoses file-level page metadata and component-level file selectors", async () => {
    const root = await app();
    const options = { root, fileRoutes: false, routes: [{ pattern: "/", component: "extra/page.html" }] };
    for (const metadata of ['<title>File title</title>', '<meta name="description" content="File description">', '<meta name="hk:layout" content="none">']) {
      await write(root, "extra/page.html", `${metadata}<template component="page-invalid"><p>Page</p></template>`);
      await expect(discoverRoutes(root, options)).rejects.toThrow(/metadata belongs inside its owning/);
    }
    await write(root, "extra/page.html", '<template component="page-invalid"><meta name="hk:page" content="page-invalid"><p>Page</p></template>');
    await expect(discoverRoutes(root, options)).rejects.toThrow(/hk:page belongs outside/);
  });

  it("rejects duplicate page component names across file and registered routes before loading application code", async () => {
    const root = await app();
    await write(root, "app/pages/admin/index.html", '<template component="home-page"><h1>Admin</h1></template>');
    await write(root, "app/pages/admin/index.server.ts", "throw new Error('Loader must not execute during discovery');");
    await expect(discoverRoutes(root)).rejects.toThrow(/Duplicate page component.*home-page.*index\.html.*\/.*\/admin\//s);
    await rm(join(root, "app/pages/admin"), { recursive: true });
    await write(root, "extra/duplicate.html", '<template component="home-page"><h1>Registered page</h1></template>');
    await expect(discoverRoutes(root, { routes: [{ pattern: "/registered/", component: "extra/duplicate.html" }] }))
      .rejects.toThrow(/Duplicate page component.*home-page.*registered/s);
    await expect(createApplication({ root, fileRoutes: false, routes: [
      { pattern: "/first/", component: "app/pages/index.html" },
      { pattern: "/second/", component: "extra/duplicate.html" },
    ] })).rejects.toThrow(/Duplicate page component.*home-page/s);
  });

  it("keeps route patterns and page names independent and permits aliases of the same page definition", async () => {
    const root = await app();
    await write(root, "extra/catalog.html", '<template component="page-products"><h1>Catalog</h1></template>');
    const routes = await discoverRoutes(root, { fileRoutes: false, routes: [
      { pattern: "/shop/", component: "extra/catalog.html" },
      { pattern: "/catalog/", component: "extra/catalog.html" },
    ] });
    expect(routes.map(route => ({ pattern: route.pattern, pageName: route.pageName }))).toEqual([
      { pattern: "/shop/", pageName: "page-products" },
      { pattern: "/catalog/", pageName: "page-products" },
    ]);
    expect(routes[0]!.component).toBe(join(root, "extra/catalog.html"));
  });

  it("requires rediscovery when a page component is renamed after application creation", async () => {
    const root = await app();
    await write(root, "extra/catalog.html", '<template component="page-products"><h1>Catalog</h1></template>');
    const application = await createApplication({ root, routes: [{ pattern: "/shop/", component: "extra/catalog.html" }] });
    try {
      await write(root, "extra/catalog.html", '<template component="home-page"><h1>Changed name</h1></template>');
      await expect(application.render("/shop/")).rejects.toThrow(/Page component name changed.*rediscover/i);
    } finally { await application.close(); }
  });

  it("renders fresh loader data through nested layouts and the HTML Next serializer", async () => {
    const root = await app();
    const application = await createApplication({ root, base: "/docs/" });
    try {
      const one = await application.render("/docs/items/one/");
      const two = await application.render("/docs/items/two/");
      expect(one.html).toContain("kit: one");
      expect(two.html).toContain("kit: two");
      expect(one.html).toContain("a &lt; b");
      expect(one.html).toContain("HTMLKit");
      expect(one.html).toContain("<title>one</title>");
      expect(one.html).toContain('data-component="items-layout"');
      expect(one.css).toContain("rgb(20, 30, 40)");
      expect((await application.render("/docs/missing/")).status).toBe(404);
    } finally { await application.close(); }
  });

  it("builds enumerated portable pages, bundles only browser inputs, and previews direct reloads", async () => {
    const root = await app();
    const result = await buildApplication({ root, base: "/docs/" });
    expect(result.routes).toEqual(["/docs/", "/docs/items/one/", "/docs/items/two/"]);
    const home = await readFile(join(result.outDir, "index.html"), "utf8");
    expect(home).toContain("<title>Home &amp; kit</title>");
    expect(home).toContain('<img alt="Mark" src="/docs/mark.svg">');
    expect(home).not.toContain('aria-invalid="true"');
    expect(home).toContain(">4</output>");
    expect(home).toMatch(/src="\/docs\/_htmlkit\/.*\.js"/);
    const manifest = JSON.parse(await readFile(join(result.outDir, "_htmlkit/manifest.json"), "utf8"));
    expect(manifest.pages.map((page: { pathname: string; pageName: string }) => ({ pathname: page.pathname, pageName: page.pageName })))
      .toEqual([{ pathname: "/docs/", pageName: "home-page" },
        { pathname: "/docs/items/one/", pageName: "item-page" }, { pathname: "/docs/items/two/", pageName: "item-page" }]);
    expect(manifest.pages.every((page: { browserModule: string }) => /^\/docs\/_htmlkit\/.*\.js$/.test(page.browserModule))).toBe(true);
    expect(result.browserInputs.some(path => /(?:server-worker|node-loader|jsdom|parse5|\.server\.|browser-source)/.test(path))).toBe(false);
    const server = await previewApplication({ root, port: 0 });
    try {
      expect(await (await fetch(server.url + "items/two/")).text()).toContain("kit: two");
      expect((await fetch(server.url + "mark.svg")).headers.get("content-type")).toContain("image/svg+xml");
      const missing = await fetch(server.url + "missing/");
      expect(missing.status).toBe(404);
      expect(await missing.text()).toContain("Page not found");
      expect((await fetch(server.url + "items/two", { redirect: "manual" })).status).toBe(308);
    } finally { await server.close(); }
  }, 60_000);

  it("requires entries and detects conflicting parameterized route patterns", async () => {
    const root = await app();
    await write(root, "app/pages/items/[slug].server.ts", "export const load = () => ({});");
    await expect(buildApplication({ root })).rejects.toThrow(/entries.*slug/i);
    await write(root, "app/pages/items/[name].html", '<template component="other-item"><h1>Other</h1></template>');
    await expect(discoverRoutes(root)).rejects.toThrow(/conflict/i);
  });

  it("uses explicit routes through the same renderer and resolves literal routes before parameters", async () => {
    const root = await app();
    await write(root, "extra/special.html", '<template component="special-page"><h1>Explicit page</h1></template>');
    const application = await createApplication({ root, fileRoutes: false, routes: [
      { pattern: "/extra/[slug]/", component: "app/pages/items/[slug].html", server: "app/pages/items/[slug].server.ts" },
      { pattern: "/extra/special/", component: "extra/special.html" },
    ] });
    try {
      expect(await application.entries()).toEqual(["/extra/one/", "/extra/special/", "/extra/two/"]);
      expect((await application.render("/extra/special/")).html).toContain("Explicit page");
      expect((await application.render("/extra/any/" )).status).toBe(200);
    } finally { await application.close(); }
  });

  it("serializes false boolean values and camelCase props independently of native DOM targets", async () => {
    const root = await app();
    await write(root, "extra/values.html", '<template component="value-page"><defs><prop name="active" type="boolean" default="true">Active</prop><prop name="itemURL" type="string" required>Link</prop></defs><section><button from:disabled="$active">{$active}</button><a from:href="$itemURL">Item</a></section></template>');
    await write(root, "extra/values.server.ts", 'export const load = () => ({ props: { active: false, itemURL: "/target/" } });');
    const application = await createApplication({ root, fileRoutes: false, routes: [{ pattern: "/", component: "extra/values.html", server: "extra/values.server.ts" }] });
    try {
      const page = await application.render("/");
      expect(page.html).toContain('<button>false</button>');
      expect(page.html).toContain('href="/target/"');
      expect(page.html).not.toContain('aria-invalid="true"');
    } finally { await application.close(); }
  });

  it("resolves component packages with import-only exports from the consuming application", async () => {
    const root = await app();
    await write(root, "node_modules/@example/controls/package.json", '{"name":"@example/controls","type":"module","exports":{"./label.html":{"import":"./label.html"},"./controller":{"import":"./controller.js"}}}');
    await write(root, "node_modules/@example/controls/label.html", '<template component="package-label" controller="@example/controls/controller"><strong>Package component</strong></template>');
    await write(root, "node_modules/@example/controls/controller.js", 'export default () => {};');
    await write(root, "extra/package.html", '<link rel="component" href="@example/controls/label.html"><template component="package-page"><main><package-label></package-label></main></template>');
    const application = await createApplication({ root, fileRoutes: false, routes: [{ pattern: "/", component: "extra/package.html" }] });
    try {
      const page = await application.render("/");
      expect(page.html).toContain("Package component");
      expect(page.components.find(component => component.definition.contract.tag === "package-label")?.controller).toContain(join("controls", "controller.js"));
    }
    finally { await application.close(); }
  });

  it("updates development pages and loader dependencies and discovers added routes", async () => {
    const root = await app();
    const server = await devApplication({ root, base: "/dev/", port: 0 });
    try {
      expect(await (await fetch(server.url)).text()).toContain("Home &amp; kit");
      await write(root, "app/pages/index.server.ts", "import { title } from './title.ts'; export const load = () => ({ props: { asset: '/mark.svg' }, head: { title } });");
      await write(root, "app/pages/title.ts", "export const title = 'Changed title';");
      await expect.poll(async () => await (await fetch(server.url)).text(), { timeout: 10_000 }).toContain("Changed title");
      await write(root, "app/pages/title.ts", "export const title = 'Dependency update';");
      await expect.poll(async () => await (await fetch(server.url)).text(), { timeout: 10_000 }).toContain("Dependency update");
      await write(root, "app/pages/new.html", '<template component="new-page"><h1>Added route</h1></template>');
      await expect.poll(async () => await (await fetch(server.url + "new/")).text(), { timeout: 10_000 }).toContain("Added route");
      await write(root, "app/pages/src/index.html", '<template component="source-page"><h1>Source route</h1></template>');
      await expect.poll(async () => await (await fetch(server.url + "src/")).text(), { timeout: 10_000 }).toContain("Source route");
      expect(await (await fetch(server.url + "items/with.dots/")).text()).toContain("kit: with.dots");
    } finally { await server.close(); }
    // Windows runners measured 18-30 s for these four updates; each still has its own 10 s limit.
  }, 60_000);

  it("rejects unsafe entries and leaves the last successful output intact after failure", async () => {
    const root = await app();
    await buildApplication({ root });
    const before = await readFile(join(root, "dist/index.html"), "utf8");
    await write(root, "app/pages/items/[slug].server.ts", "export const entries = () => [{ slug: '../escape' }];");
    await expect(buildApplication({ root })).rejects.toThrow(/segment/i);
    expect(await readFile(join(root, "dist/index.html"), "utf8")).toBe(before);
    await expect(buildApplication({ root, outDir: "." })).rejects.toThrow(/output/i);
  }, 60_000);

  it("protects source behind directory aliases and does not serve symlinked page indexes outside output", async () => {
    const root = await app();
    await symlink(join(root, "app"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    await expect(buildApplication({ root, outDir: "alias/generated" })).rejects.toThrow(/unsafe output/i);
    const result = await buildApplication({ root });
    await rm(join(result.outDir, "items/one/index.html"));
    await symlink(join(root, "package.json"), join(result.outDir, "items/one/index.html"));
    const server = await previewApplication({ root, port: 0 });
    try {
      const response = await fetch(server.url + "items/one/");
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("Page not found");
    } finally { await server.close(); }
  }, 60_000);

  it("diagnoses request-only inputs, missing props, missing layout slots, and output collisions", async () => {
    const root = await app();
    await write(root, "app/pages/index.server.ts", "export function load(context) { return { props: { asset: context.request.url } }; }");
    await expect(buildApplication({ root })).rejects.toThrow(/request.*static/i);
    await write(root, "app/pages/index.server.ts", "export const load = () => ({ props: {} });");
    await expect(buildApplication({ root })).rejects.toThrow(/required prop/i);
    await write(root, "app/layouts/default.html", '<template component="bad-layout"><main>Missing projection</main></template>');
    await expect(buildApplication({ root })).rejects.toThrow(/slot.*page/i);
    await write(root, "app/layouts/default.html", '<template component="good-layout"><main><slot name="page"></slot></main></template>');
    await write(root, "app/layouts/default.server.ts", "export const load = () => ({ data: { owner: 'kit' } });");
    await write(root, "app/pages/index.server.ts", "export const load = () => ({ props: { asset: '/mark.svg' } });");
    await write(root, "public/index.html", "collision");
    await expect(buildApplication({ root })).rejects.toThrow(/collision/i);
  }, 60_000);
});
