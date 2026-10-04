import { readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, createApplication, discoverRoutes, devApplication, previewApplication } from "../src/index.js";
import { fixture, write } from "./fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function app(): Promise<string> { const root = await fixture(); roots.push(root); return root; }

describe("application platform", () => {
  it("discovers routes and ancestor layouts without importing controllers", async () => {
    const root = await app();
    const routes = await discoverRoutes(root);
    expect(routes.map(route => route.pattern)).toEqual(["/", "/items/[slug]/"]);
    expect(routes[1]!.layouts).toHaveLength(2);
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
    await write(root, "extra/values.html", '<template component="value-page"><defs><prop name="active" type="boolean" default="true">Active</prop><prop name="itemURL" type="string" required>Link</prop></defs><section><button from:disabled="active" $value="active"></button><a from:href="itemURL">Item</a></section></template>');
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
      expect(page.components.find(component => component.definition.contract.tag === "package-label")?.controller).toContain("controls/controller.js");
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
  }, 30_000);

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
    await write(root, "app/pages/_layout.html", '<template component="bad-layout"><main>Missing projection</main></template>');
    await expect(buildApplication({ root })).rejects.toThrow(/slot.*page/i);
    await write(root, "app/pages/_layout.html", '<template component="good-layout"><main><slot name="page"></slot></main></template>');
    await write(root, "app/pages/_layout.server.ts", "export const load = () => ({ data: { owner: 'kit' } });");
    await write(root, "app/pages/index.server.ts", "export const load = () => ({ props: { asset: '/mark.svg' } });");
    await write(root, "public/index.html", "collision");
    await expect(buildApplication({ root })).rejects.toThrow(/collision/i);
  }, 60_000);
});
