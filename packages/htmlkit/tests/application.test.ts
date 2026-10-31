import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeHydrationValue, decodeHydrationValue } from "../../html-next/src/bindings.js";

import { buildApplication, createApplication, discoverRoutes, devApplication, previewApplication } from "../src/index.js";
import { bindingFixture, environmentFixture, fixture, privateFixture, preparedFixture, retainedProviderFixture, universalFixture, titleOf, write } from "./fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function app(): Promise<string> { const root = await fixture(); roots.push(root); return root; }

describe("application platform", () => {
  it("prepares a library-owned binding before render and preserves caller overrides", async () => {
    const root = await preparedFixture(); roots.push(root);
    const application = await createApplication({ root });
    try {
      const page = await application.render("/");
      expect(page.body).toContain("<h1>build:A</h1>");
      expect(page.body).toContain('value="build:A"');
      expect(page.body).toContain("data-htmlkit-bindings=");
      expect(page.body).not.toContain('data-connected="true"');
      expect((await application.render("/fixture/")).body).toContain("<h1>Caller</h1>");
    } finally { await application.close(); }
  });
  it("diagnoses invalid prepared-module functions and unsupported environment overrides", async () => {
    const root = await preparedFixture(); roots.push(root);
    await write(root, "lib/entry.client.ts", "export const props = { label: { load: () => 'Override' } };");
    const application = await createApplication({ root });
    try { await expect(application.render("/")).rejects.toThrow(/environment provider overrides require an unbound props\/create module/); }
    finally { await application.close(); }
    await rm(join(root, "lib/entry.client.ts"));
    const source = await readFile(join(root, "lib/binding.ts"), "utf8");
    await write(root, "lib/binding.ts", source.replace("adopt(host, options) { return binding(host, options.snapshot.source).adopt(host, options); }", "adopt: 42"));
    const invalid = await createApplication({ root });
    try { await expect(invalid.render("/")).rejects.toThrow(/Prepared component prepared-index must export adopt/); }
    finally { await invalid.close(); }
  });
  it.each([false, true])("prepares a layout provider when a typed id prop supplies the native root id (delegated: %s)", async delegated => {
    const root = await retainedProviderFixture(delegated); roots.push(root);
    const application = await createApplication({ root, services: { read: (id: string) => "Product:" + id } });
    try {
      const page = await application.render("/");
      expect(page.body).toContain('id="A"');
      expect(page.body).toContain("<h2>Product:A</h2>");
    } finally { await application.close(); }
  });
  it("recomputes private read inputs and authorizes each real request without exposing private failures", async () => {
    const root = await privateFixture(); roots.push(root);
    const source = await readFile(join(root, "app/pages/index.ts"), "utf8");
    await write(root, "app/pages/index.ts", source.replace("state.query", "state.query.toUpperCase()"));
    let reads = 0;
    const application = await createApplication({ root, services: { read(query: string, context: { phase: string; cookies: ReadonlyMap<string, string> }) {
      reads += 1;
      if (context.phase === "build") return "Build";
      if (!context.cookies.has("user")) throw new Response("Sign in", { status: 403 });
      if (query === "SECRET") throw new Error("DO_NOT_EXPOSE_PRIVATE_DETAILS");
      return query + ":" + context.cookies.get("user");
    } } });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const page = await application.render("/");
      const revision = page.components.find(component => component.definition.contract.tag === "client-page")!.binding!.source;
      const packet = { version: 1, source: revision, tag: "client-page", name: "label", url: "http://localhost/",
        inputs: encodeHydrationValue({ props: {}, state: { query: "b" } }) };
      const send = (body = packet, user = true) => application.fetch(new Request("http://localhost/_htmlkit/read", {
        method: "POST", headers: { "content-type": "application/json", ...user ? { cookie: "user=Grace" } : {} }, body: JSON.stringify(body),
      }));
      const response = await send();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(decodeHydrationValue((await response.json()).value)).toBe("B:Grace");
      expect((await send(packet, false)).status).toBe(403);
      expect((await send({ ...packet, inputs: encodeHydrationValue({ props: {}, state: { query: 42 } }) })).status).toBe(400);
      expect((await send({ ...packet, name: "constructor" })).status).toBe(404);
      expect((await send({ ...packet, source: "stale" })).status).toBe(409);
      expect((await send({ ...packet, inputs: ["reference", 999] })).status).toBe(400);
      expect((await send({ ...packet, url: "https://elsewhere.test/" })).status).toBe(400);
      expect((await send({ ...packet, inputs: encodeHydrationValue({ props: {}, state: { query: "b", invented: true } }) })).status).toBe(400);
      expect((await application.fetch(new Request("http://localhost/_htmlkit/read"))).status).toBe(405);
      expect((await application.fetch(new Request("http://localhost/_htmlkit/read", { method: "POST", headers: { origin: "https://elsewhere.test" }, body: JSON.stringify(packet) }))).status).toBe(403);
      expect(reads).toBe(3);
      const failed = await send({ ...packet, inputs: encodeHydrationValue({ props: {}, state: { query: "secret" } }) });
      expect(failed.status).toBe(500);
      expect(await failed.text()).not.toContain("DO_NOT_EXPOSE_PRIVATE_DETAILS");
      expect(logged).toHaveBeenCalledTimes(1);
    } finally { logged.mockRestore(); await application.close(); }
  });
  it("aborts parent-owned private work when its server render is cancelled", async () => {
    const root = await privateFixture(); roots.push(root);
    let started!: () => void; let stopped!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const cancelled = new Promise<void>(resolve => { stopped = resolve; });
    const application = await createApplication({ root, services: { read(_query: string, { signal }: { signal: AbortSignal }) {
      started();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { stopped(); reject(signal.reason); }, { once: true }));
    } } });
    const abort = new AbortController();
    const result = application.fetch(new Request("http://localhost/live/?q=hold", { signal: abort.signal }));
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    try {
      await reading; abort.abort(); await rejected; await cancelled;
    } finally { abort.abort(); await application.close(); }
  });
  it("closes only its own pending private browser reads", async () => {
    const root = await privateFixture(); roots.push(root);
    let started!: () => void; let stopped!: () => void; let complete!: (value: string) => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const cancelled = new Promise<void>(resolve => { stopped = resolve; });
    const services = { read(query: string, { phase, signal }: { phase: string; signal: AbortSignal }) {
      if (phase === "build" || query !== "hold") return query;
      started(); return new Promise<string>(resolve => { complete = resolve; signal.addEventListener("abort", stopped, { once: true }); });
    } };
    const application = await createApplication({ root, services });
    const other = await createApplication({ root, services });
    try {
      const source = (await application.render("/")).components.find(component => component.binding !== undefined)!.binding!.source;
      const result = application.fetch(new Request("http://localhost/_htmlkit/read", { method: "POST", body: JSON.stringify({
        version: 1, source, tag: "client-page", name: "label", url: "http://localhost/", inputs: encodeHydrationValue({ props: {}, state: { query: "hold" } }),
      }) }));
      const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
      await reading; await application.close(); await cancelled; await rejected;
      complete("Late result");
      expect((await other.render("/")).body).toContain("<h1>A</h1>");
    } finally { await Promise.all([application.close(), other.close()]); }
  });
  it("runs private readers with real request context and parent-owned services", async () => {
    const root = await privateFixture(); roots.push(root);
    const calls: string[] = [];
    const application = await createApplication({ root, services: { async read(query: string, context: { phase: string; signal: AbortSignal; request: Request }) {
      context.signal.throwIfAborted();
      calls.push(context.phase + ':' + query);
      return context.phase + ':' + query + (context.phase === 'request' ? ':' + context.request.headers.get('x-user') : '');
    } } });
    try {
      expect((await application.render("/")).body).toContain("<h1>build:A</h1>");
      expect((await application.render("/fixture/")).body).toContain("<h1>Fixture</h1>");
      const response = await application.fetch(new Request("http://localhost/live/?q=C", { headers: { 'x-user': 'Ada' } }));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<h1>request:C:Ada</h1>");
      expect(calls).toEqual(["build:A", "request:C"]);
    } finally { await application.close(); }
  });
  it("distinguishes private registrations for different definitions sharing a tag and common module", async () => {
    const root = await privateFixture(); roots.push(root);
    for (const [page, file] of [["index", "one"], ["fixture", "two"]] as const) {
      const source = await readFile(join(root, `app/pages/${page}.html`), "utf8");
      await write(root, `app/pages/${page}.html`, `<link rel="component" href="../components/${file}.html">` + source.replace("</main>", "<shared-private></shared-private></main>"));
      await write(root, `app/components/${file}.html`, `<template component="shared-private" module="../pages/index.ts"><defs>
        <prop name="label" type="string" required>Label.</prop><state name="query" type="string" value="A"></state></defs><section><p $await="$label">{$label}</p></section></template>`);
    }
    const application = await createApplication({ root, services: { read: () => "Prepared" } });
    try {
      const first = (await application.render("/")).components.find(component => component.definition.contract.tag === "shared-private")!;
      const second = (await application.render("/fixture/")).components.find(component => component.definition.contract.tag === "shared-private")!;
      expect(first.binding!.source).not.toBe(second.binding!.source);
    } finally { await application.close(); }
  });
  it("keeps client companions out of server imports while preserving shared selectors and fixtures", async () => {
    const root = await environmentFixture(); roots.push(root);
    const application = await createApplication({ root });
    try {
      const page = await application.render("/");
      expect(page.body).toContain("Waiting.");
      expect(page.components.find(component => component.definition.contract.tag === "client-page")).toMatchObject({ client: join(root, "app/pages/index.client.ts") });
      expect((await application.render("/only/")).body).toContain("Waiting.");
      expect((await application.render("/mixed/")).body).toContain("<h1>build:A</h1>");
      expect((await application.render("/fixture/")).body).toContain("<h1>Fixture</h1>");
      const live = await application.fetch(new Request("http://localhost/live/?q=C"));
      expect(live.status).toBe(200);
      expect(await live.text()).toContain("Waiting.");
    } finally { await application.close(); }
  });
  it("bundles client readers only into the browser graph", async () => {
    const root = await environmentFixture(); roots.push(root);
    const result = await buildApplication({ root });
    expect(result.browserInputs.some(file => file.includes("index.client.ts"))).toBe(true);
    const directory = join(result.outDir, "_htmlkit/server");
    const files = await readdir(directory, { recursive: true });
    for (const file of files.filter(file => file.endsWith(".js"))) {
      expect(await readFile(join(directory, file), "utf8")).not.toMatch(/CLIENT_GRAPH_ONLY|environmentCreates|@example\/browser-only/);
    }
  });
  for (const query of ["", "?raw", "?url"]) it(`refuses a client companion's transitive import of a private server module${query}`, async () => {
    const root = await environmentFixture(); roots.push(root);
    await write(root, "app/lib/secret.server.ts", 'export const secret = "SERVER_GRAPH_SECRET";');
    await write(root, "app/pages/only.client.ts", `import ${query === "" ? "{ secret }" : "secret"} from "../lib/secret.server.ts${query}"; export const props = { label: { input: () => null, load: () => secret } };`);
    await expect(buildApplication({ root })).rejects.toThrow(/secret\.server\.ts.*server-only|server-only.*secret\.server\.ts/s);
  });
  it("diagnoses ambiguous client companions and honors an explicitly selected client entry", async () => {
    const root = await environmentFixture(); roots.push(root);
    await write(root, "app/pages/only.client.js", "export function connect() {};");
    const application = await createApplication({ root });
    try {
      await expect(application.render("/only/")).rejects.toThrow(/ambiguous.*only\.client\.js.*only\.client\.ts/);
      const source = await readFile(join(root, "app/pages/only.html"), "utf8");
      await write(root, "app/pages/only.html", source.replace('component="client-only-page"', 'component="client-only-page" module="./only.client.ts"'));
      const page = await application.render("/only/");
      expect(page.components.find(component => component.definition.contract.tag === "client-only-page")).toMatchObject({ client: join(root, "app/pages/only.client.ts") });
      expect(page.body).toContain("Waiting.");
    } finally { await application.close(); }
  });
  it("keeps local type exports out of server preparation", async () => {
    const root = await universalFixture(); roots.push(root);
    await write(root, "app/components/browser-only.ts", `import { doc } from "@example/browser-only";
      interface LocalProps { label: string }
      type LocalCreate = () => LocalProps;
      export { LocalProps as props, LocalCreate as create };
      export function connect(host) { host.root.dataset.browser = doc === host.root.ownerDocument ? "connected" : "wrong"; }`);
    const application = await createApplication({ root });
    try {
      const page = await application.render("/");
      expect(page.body).toContain("<h1>build:A</h1>");
      expect(page.components.find(component => component.definition.contract.tag === "browser-only-node")?.binding).toBeUndefined();
    } finally { await application.close(); }
  });
  it("diagnoses required inputs that have no caller or provider", async () => {
    const root = await universalFixture(); roots.push(root);
    const source = await readFile(join(root, "app/pages/index.html"), "utf8");
    await write(root, "app/pages/index.html", source.replace('<state name="query"', '<prop name="missing" type="string" required>Missing input.</prop><state name="query"'));
    const application = await createApplication({ root });
    try { await expect(application.render("/")).rejects.toThrow(/required prop `missing` of <universal-page>/); }
    finally { await application.close(); }
  });
  it("prepares shared component providers for prerender and SSR while bypassing fixtures and browser-only modules", async () => {
    const root = await universalFixture(); roots.push(root);
    const application = await createApplication({ root });
    let preparedModule: string | undefined;
    try {
      const page = await application.render("/");
      preparedModule = page.components.find(component => component.definition.contract.tag === "universal-page")!.binding!.module;
      expect(existsSync(fileURLToPath(preparedModule))).toBe(true);
      expect(page.body).toContain("<h1>build:A</h1>");
      expect(page.body).toContain('value="build:A"');
      expect(titleOf(page)).toBe("Product build:A");
      expect(page.body).toContain('<p class="details">build:details:build:A</p>');
      expect(page.body).toContain('<output class="details-draft">build:details:build:A</output>');
      expect(page.body).not.toContain('data-connections="1"');
      expect(page.body).toContain("Browser behavior");
      const supplied = await application.render("/fixture/");
      expect(supplied.body).toContain("<h1>Fixture</h1>");
      expect(supplied.body).toContain('value="Fixture"');
      const live = await application.fetch(new Request("http://localhost/live/?q=C"));
      expect(live.status).toBe(200);
      expect(await live.text()).toContain("<h1>request:C</h1>");
      const failed = await application.fetch(new Request("http://localhost/live/?q=bad"));
      expect(failed.status).toBe(200);
      expect(await failed.text()).toContain('<p class="error">Unavailable product</p>');
      const delegated = await application.render("/delegated/");
      expect(delegated.body).toContain("<h1>build:A</h1>");
      expect(delegated.body).toContain('<strong class="shell-label">build:shell</strong>');
      const deferred = await application.render("/deferred/");
      expect(deferred.body).toContain("Waiting.");
      expect(deferred.body).not.toContain("<h1>");
    } finally { await application.close(); }
    expect(existsSync(fileURLToPath(preparedModule!))).toBe(false);
  });
  it("reloads transitive provider dependencies for concurrent development requests", async () => {
    const root = await universalFixture(); roots.push(root);
    const server = await devApplication({ root, port: 0 });
    try {
      expect(await (await fetch(server.url)).text()).toContain("<h1>build:A</h1>");
      const source = await readFile(join(root, "lib/product.ts"), "utf8");
      await write(root, "lib/product.ts", source.replace("phase + ':' + query", "'Updated:' + query"));
      await expect.poll(async () => Promise.all(Array.from({ length: 3 }, async () => (await fetch(server.url)).text())), { timeout: 10_000 })
        .toEqual(Array.from({ length: 3 }, () => expect.stringContaining("<h1>Updated:A</h1>")));
    } finally { await Promise.all([server.close(), server.close()]); }
  }, 60_000);
  it("resolves a prepared module's package imports from the application", async () => {
    const root = await universalFixture(); roots.push(root);
    await write(root, "node_modules/@example/shared-record/package.json", '{"name":"@example/shared-record","type":"module","exports":"./index.js"}');
    await write(root, "node_modules/@example/shared-record/index.js", 'export const record = name => ({ name });');
    const source = await readFile(join(root, "lib/product.ts"), "utf8");
    await write(root, "lib/product.ts", 'import { record } from "@example/shared-record";\n' + source.replace("return { name: phase + ':' + query };", "return record(phase + ':' + query);"));
    const application = await createApplication({ root });
    try { expect((await application.render("/")).body).toContain("<h1>build:A</h1>"); }
    finally { await application.close(); }
  });
  it("preserves omitted defaults and supplied null inputs in SSR and navigation payloads", async () => {
    const root = await bindingFixture(); roots.push(root);
    const application = await createApplication({ root });
    try {
      const page = await application.render("/defaults/");
      expect(page.body).toContain("<h1>Default</h1>");
      expect(page.body).toContain('<output class="count">0</output>');
      expect(page.body).not.toContain("Nullable waiting.");
      expect(page.layers.at(-1)).toMatchObject({ attributes: { label: "Default", count: "0" }, props: { nullable: null, count: null } });
      const payload = await (await application.fetch(new Request("http://localhost/_htmlkit/pages/defaults/payload.json"))).json();
      expect(payload.layers.at(-1).props).toEqual({ nullable: null, count: null });
    } finally { await application.close(); }
  });
  it("uses HTML navigation when JSON would change a typed caller input", async () => {
    const root = await app();
    await write(root, "extra/signed.html", '<template component="signed-page"><defs><prop name="value" type="number" required>Value.</prop></defs><output>{$value}</output></template>');
    await write(root, "extra/signed.server.ts", 'export const load = () => ({ props: { value: -0 } });');
    const application = await createApplication({ root, fileRoutes: false, routes: [{ pattern: "/", component: "extra/signed.html", server: "extra/signed.server.ts" }] });
    try {
      expect((await application.render("/")).body).toContain(">0</output>");
      expect((await application.fetch(new Request("http://localhost/_htmlkit/pages/payload.json"))).status).toBe(404);
    } finally { await application.close(); }
  });
  it("resolves a component's sibling module without running its browser providers", async () => {
    const root = await bindingFixture(); roots.push(root);
    const application = await createApplication({ root });
    try {
      const page = await application.render("/");
      expect(page.components.find(component => component.definition.contract.tag === "binding-card")?.module).toBe(join(root, "app/components/card.ts"));
      expect(page.body).toContain("Waiting.");
      expect(page.body).toContain("Fixture");
      await write(root, "app/components/card.js", "export function connect() {};");
      await expect(application.render("/")).rejects.toThrow(/ambiguous.*card\.(?:js|ts)|card\.(?:js|ts).*ambiguous/i);
      const source = await readFile(join(root, "app/components/card.html"), "utf8");
      await write(root, "app/components/card.html", source.replace('component="binding-card"', 'component="binding-card" module="./card.ts"'));
      expect((await application.render("/")).components.find(component => component.definition.contract.tag === "binding-card")?.module).toBe(join(root, "app/components/card.ts"));
      await write(root, "app/components/card.html", (await readFile(join(root, "app/components/card.html"), "utf8")) + '<template component="card-helper"><small>Helper</small></template>');
      const carrier = await application.render("/");
      expect(carrier.components.find(component => component.definition.contract.tag === "binding-card")?.module).toBe(join(root, "app/components/card.ts"));
      expect(carrier.components.find(component => component.definition.contract.tag === "card-helper")?.module).toBeUndefined();
      await rm(join(root, "app/components/card.js"));
      await write(root, "app/components/card.html", source + '<template component="card-helper"><small>Helper</small></template>');
      await expect(application.render("/")).rejects.toThrow(/several components/);
    } finally { await application.close(); }
  });

  it("selects one page among helpers and applies named, directory, default, and disabled layouts", async () => {
    const root = await app();
    await rm(join(root, "app/layouts/default.server.ts"));
    await write(root, "app/layouts/default.html", '<template component="default-shell"><main>Default<slot name="page"></slot></main></template>');
    await write(root, "app/layouts/admin.html", '<template component="admin-shell"><main>Admin<slot name="page"></slot></main></template>');
    await write(root, "extra/products.html", '<meta name="hk:page" content="page-products"><template component="product-label"><defs><meta name="hk:layout" content="absent"></defs><strong>Helper</strong></template><template component="page-products"><defs><meta name="hk:layout" content="admin"><title>Products</title></defs><product-label></product-label></template>');
    await write(root, "extra/plain.html", '<template component="page-plain"><defs><meta name="hk:layout" content="none"></defs><p>Standalone</p></template>');
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
      expect((await application.render("/products/")).body).toContain('component="admin-shell"');
      expect((await application.render("/products/")).body).toContain("Helper");
      expect(titleOf(await application.render("/products/"))).toBe("Products");
      expect((await application.render("/plain/")).body).not.toContain("shell");
      expect((await application.render("/default/")).body).toContain('component="default-shell"');
      expect((await application.render("/admin/")).body).toContain('component="admin-shell"');
    } finally { await application.close(); }
    await write(root, "extra/products.html", '<template component="product-label"><p>Label</p></template><template component="page-products"><p>Page</p></template>');
    await expect(discoverRoutes(root, options)).rejects.toThrow(/hk:page/);
    await write(root, "extra/products.html", '<meta name="hk:page" content="absent-page"><template component="page-products"><p>Page</p></template>');
    await expect(discoverRoutes(root, options)).rejects.toThrow(/absent-page/);
  }, 60_000);

  it("renders head declarations bound to loader props, the page's over its layout's", async () => {
    const root = await app();
    await rm(join(root, "app/layouts/default.server.ts"));
    await write(root, "app/layouts/default.html", '<template component="head-shell"><defs><title>Site title</title><meta name="description" content="Site description"><meta property="og:title" content="Site"><link rel="canonical" href="https://example.test/"><link rel="alternate" hreflang="en" href="https://example.test/en/"><script src="https://js.pay.example/v3/"></script></defs><main><slot name="page"></slot></main></template>');
    await write(root, "extra/head.html", '<meta name="hk:page" content="page-head"><template component="head-helper"><strong>Helper content</strong></template><template component="page-head"><defs><prop name="title" type="string" required>Title</prop><prop name="description" type="string" required>Description</prop><prop name="canonical" type="string" required>Canonical</prop><title>{$title}</title><meta name="hk:layout" content="default"><meta name="description" from:content="$description"><meta property="og:title" from:content="$title"><meta property="og:image" content="https://example.test/a.png"><meta property="og:image" content="https://example.test/b.png"><link rel="canonical" from:href="$canonical"><link rel="alternate" hreflang="fr" href="https://example.test/fr/"><script type="application/ld+json">{"@type":"WebPage"}</script><script name="maps" src="https://maps.example/sdk.js" loading="lazy"></script></defs><section><p>{$title}</p><head-helper></head-helper></section></template>');
    await write(root, "extra/head.server.ts", 'export const load = () => ({ props: { title: "Page & title", description: "a < b", canonical: "https://example.test/page/" } });');
    const application = await createApplication({ root, fileRoutes: false, routes: [{ pattern: "/", component: "extra/head.html", server: "extra/head.server.ts" }] });
    try {
      const { html } = await application.render("/");
      const head = html.split("<head>")[1]!.split("</head>")[0]!;
      expect(head).toContain(">Page &amp; title</title>");
      expect(head).toContain('name="description" content="a < b"');
      expect(head).toContain('property="og:title" content="Page &amp; title"');
      expect(head).toContain('href="https://example.test/page/"');
      expect(head).not.toContain("Site description");
      expect(head.match(/rel="canonical"/g)).toHaveLength(1);
      for (const value of ['hreflang="en"', 'hreflang="fr"', "a.png", "b.png"]) expect(head).toContain(value);
      // An eager declared script is preloaded, never run, by server rendering; a lazy one waits for the browser.
      expect(head).toContain('<link rel="preload" as="script" href="https://js.pay.example/v3/" data-component-head="">');
      expect(head.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")).not.toMatch(/<script src|maps\.example/);
      expect(head).toContain('<script type="application/ld+json" data-component-head="">{"@type":"WebPage"}</script>');
      // HTMLKit reads its hk: settings and leaves them out of the head.
      expect(head).not.toMatch(/hk:|from:|\{\$/);
      expect(html.split("</head>")[1]).toContain("Helper content");
    } finally { await application.close(); }
  });
  it("inlines app/head.js before stylesheets and rejects text that would end its script", async () => {
    const prepaint = "<script>document.documentElement.dataset.prepaint = String(document.body === null);</script>";
    const root = await app();
    const application = await createApplication({ root });
    try {
      const { html } = await application.render("/");
      expect(html).toMatch(/<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="[^"]*"><script>document\.documentElement\.dataset\.prepaint = String\(document\.body === null\);<\/script><meta name="viewport"/);
      // The not-found page gets it too, rendered and built, so a saved theme never flashes there.
      expect((await application.render("/missing/")).html).toContain(prepaint);
    } finally { await application.close(); }
    await buildApplication({ root });
    expect(await readFile(join(root, "dist/404.html"), "utf8")).toContain(prepaint);
    await write(root, "app/head.js", 'console.log("</SCRIPT>");');
    await expect(createApplication({ root })).rejects.toThrow("app/head.js cannot contain");
    // A loader's head sets only the language; anything else names the head declarations instead.
    await rm(join(root, "app/head.js"));
    await write(root, "app/layouts/default.server.ts", 'export const load = () => ({ props: { brand: "HTMLKit" }, head: { title: "Loaded", script: "injected()" } });');
    const unscripted = await createApplication({ root });
    try { await expect(unscripted.render("/")).rejects.toThrow("A loader's head sets only lang"); }
    finally { await unscripted.close(); }
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
      expect(html).toContain(">Home &amp; kit</title>");
      expect(html).toContain("<script>document.documentElement.dataset.prepaint");
      expect(html).not.toContain("@vite/client");
      expect(await (await handle(new Request("http://localhost/", { method: "HEAD" }))).text()).toBe("");
      const redirect = await handle(new Request("http://localhost/items/one?query"));
      expect([redirect.status, redirect.headers.get("location")]).toEqual([308, "/items/one/?query"]);
      expect(await (await handle(new Request("http://localhost/items/one/"))).text()).toContain("kit: one");
      expect((await handle(new Request("http://localhost/missing/"))).status).toBe(404);
      // A leading // would name another origin; it is simply not a page here.
      expect((await handle(new Request("http://localhost//evil.example/"))).status).toBe(404);
      expect((await handle(new Request("http://localhost/_htmlkit/pages//evil.example/payload.json"))).status).toBe(404);
      const post = await handle(new Request("http://localhost/", { method: "POST" }));
      expect([post.status, post.headers.get("allow")]).toEqual([405, "GET, HEAD"]);
      // Each page's payload, through the same render: its head, and each layer's invocation and state.
      const payload = await handle(new Request("http://localhost/_htmlkit/pages/payload.json"));
      expect([payload.status, payload.headers.get("content-type")]).toEqual([200, "application/json"]);
      expect(await payload.json()).toMatchObject({ version: 1, modules: [], styles: [],
        head: { lang: "en" },
        layers: [{ component: "app-layout", attributes: { brand: "HTMLKit" } }, { component: "home-page", attributes: { asset: "/mark.svg" }, state: { count: 4 } }] });
      expect(JSON.stringify(await (await handle(new Request("http://localhost/_htmlkit/pages/items/one/payload.json"))).json())).not.toContain("owner");
      for (const path of ["missing/payload.json", "items/payload.json", "payload.json/", "items/one/other.json"]) {
        expect((await handle(new Request(`http://localhost/_htmlkit/pages/${path}`))).status).toBe(404);
      }
    } finally { await application.close(); }
  }, 60_000);

  it("leaves out the payload of a page whose state JSON cannot carry exactly", async () => {
    const root = await app();
    await write(root, "app/pages/index.server.ts", "export const load = () => ({ props: { asset: '/mark.svg' }, state: { count: -0 } });");
    const result = await buildApplication({ root });
    await expect(readFile(join(result.outDir, "_htmlkit/pages/payload.json"))).rejects.toThrow(/ENOENT/);
    expect(JSON.parse(await readFile(join(result.outDir, "_htmlkit/pages/items/one/payload.json"), "utf8")).layers[1].component).toBe("item-page");
    const application = await createApplication({ root });
    try { expect((await application.fetch(new Request("http://localhost/_htmlkit/pages/payload.json"))).status).toBe(404); }
    finally { await application.close(); }
  }, 60_000);

  it("gives each page graph with shared stylesheet imports its own stylesheet, even under one layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "htmlkit-shared-css-")); roots.push(root);
    await write(root, "package.json", '{"type":"module"}');
    await write(root, "app/layouts/default.html", '<template component="site-shell"><main><slot name="page"></slot></main><style>:host { color: rgb(1, 1, 1); }</style></template>');
    await write(root, "app/styles/card.css", ".card { border-color: rgb(7, 7, 7); }");
    for (const [file, tag, color] of [["index", "home-page", "rgb(2, 2, 2)"], ["guide", "guide-page", "rgb(3, 3, 3)"]]) {
      await write(root, `app/pages/${file}.html`, `<template component="${tag}"><article class="card"><h1>${tag}</h1></article><style>@import "@/app/styles/card.css"; h1 { color: ${color}; }</style></template>`);
    }
    const result = await buildApplication({ root });
    const css = async (page: string) => {
      const html = await readFile(join(result.outDir, page), "utf8");
      return (await Promise.all([...html.matchAll(/href="\/(_htmlkit\/[^"]+\.css)"/g)].map(match => readFile(join(result.outDir, match[1]!), "utf8")))).join("");
    };
    // Both graphs start with the layout; each page still links its own styles, not the last page's.
    for (const [page, own, other] of [["index.html", "home-page", "guide-page"], ["guide/index.html", "guide-page", "home-page"]] as const) {
      const styles = await css(page);
      expect([styles.includes(`[component~=${own}]`), styles.includes(`[component~=${other}]`), styles.includes("#070707")]).toEqual([true, false, true]);
    }
  }, 60_000);

  it("resolves @/ from the project root and links built-in components without a link", async () => {
    const root = await mkdtemp(join(tmpdir(), "htmlkit-alias-")); roots.push(root);
    await write(root, "package.json", '{"type":"module"}');
    await write(root, "components/card.html", '<template component="app-card" controller="@/controllers/card.ts"><p>Card</p><style>@import "@/styles/card.css";</style></template>');
    await write(root, "controllers/card.ts", "export default function (host) { host.root.dataset.card = 'ready'; }");
    await write(root, "styles/card.css", "p { color: rgb(1, 2, 3); }");
    await write(root, "lib/title.ts", "export const title = 'From @/';");
    await write(root, "app/pages/index.html", '<link rel="component" href="@/components/card.html"><template component="page-home"><defs><prop name="links" type="list(object({ href: string, label: string, current: string, depth: number, pageName: string }))" required>Links</prop><prop name="title" type="string" required>Title</prop><title>{$title}</title></defs><main><app-card></app-card><hk-nav from:items="$links"></hk-nav></main></template>');
    await write(root, "app/pages/index.server.ts", "import { title } from '@/lib/title.ts'; export const load = async ({ navigation }) => ({ props: { links: await navigation(), title } });");
    const application = await createApplication({ root });
    try {
      const { html } = await application.render("/");
      expect(html).toContain(">From @/</title>");
      expect(html).toContain("Card");
      expect(html).toMatch(/<nav[^>]*component="hk-nav"/);
    } finally { await application.close(); }
    const result = await buildApplication({ root });
    expect(result.browserInputs.some(input => input.endsWith("controllers/card.ts"))).toBe(true);
    // Only source files: tools read each input, and HTMLKit's virtual stylesheets have no file.
    expect(result.browserInputs.filter(input => !existsSync(input))).toEqual([]);
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
    const pages = '<template component="page-first"><defs><meta name="hk:layout" content="none"><title>First title</title><meta name="description" content="First description"></defs><p>First page</p></template>' +
      '<template component="page-second"><defs><meta name="hk:layout" content="default"><title>Second title</title><meta name="description" content="Second description"></defs><p>Second page</p></template>';
    for (const selected of ["first", "second"]) {
      await write(root, "extra/pages.html", `<meta name="hk:page" content="page-${selected}">${pages}`);
      const application = await createApplication({ root, fileRoutes: false, routes: [{ pattern: "/", component: "extra/pages.html" }] });
      try {
        const page = await application.render("/");
        expect(titleOf(page)).toBe(selected === "first" ? "First title" : "Second title");
        expect(page.head.html).toContain(`content="${selected === "first" ? "First description" : "Second description"}"`);
        expect(page.body.includes('component="app-layout"')).toBe(selected === "second");
        expect(page.body).not.toMatch(/<title|<meta/);
      } finally { await application.close(); }
    }
  });

  it("diagnoses file-level page metadata and component-level file selectors", async () => {
    const root = await app();
    const options = { root, fileRoutes: false, routes: [{ pattern: "/", component: "extra/page.html" }] };
    for (const metadata of ['<title>File title</title>', '<meta name="description" content="File description">', '<meta name="hk:layout" content="none">']) {
      await write(root, "extra/page.html", `${metadata}<template component="page-invalid"><p>Page</p></template>`);
      await expect(discoverRoutes(root, options)).rejects.toThrow(/metadata belongs in its <template component>'s <defs>/);
      // Head content and settings are head declarations, so they belong in the carrier's <defs>.
      await write(root, "extra/page.html", `<template component="page-invalid">${metadata}<p>Page</p></template>`);
      await expect(discoverRoutes(root, options)).rejects.toThrow("belongs in <page-invalid>'s <defs>");
    }
    await write(root, "extra/page.html", '<template component="page-invalid"><defs><meta name="hk:page" content="page-invalid"></defs><p>Page</p></template>');
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
      expect(one.html).toContain(">one</title>");
      expect(one.html).toContain('component="items-layout"');
      expect(one.css).toContain("rgb(20, 30, 40)");
      expect((await application.render("/docs/missing/")).status).toBe(404);
    } finally { await application.close(); }
  });

  it("builds enumerated portable pages, bundles only browser inputs, and previews direct reloads", async () => {
    const root = await app();
    const result = await buildApplication({ root, base: "/docs/" });
    expect(result.routes).toEqual(["/docs/", "/docs/items/one/", "/docs/items/two/"]);
    const home = await readFile(join(result.outDir, "index.html"), "utf8");
    expect(home).toContain(">Home &amp; kit</title>");
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
    // Pages ship their components compiled to direct DOM code and the helpers those use, not the live interpreter.
    expect(result.browserInputs.some(path => /html-next[/\\](?:src|dist)[/\\]generated-runtime\.(?:ts|js)$/.test(path))).toBe(true);
    expect(result.browserInputs.filter(path => /html-next[/\\](?:src|dist)[/\\](?:runtime|live|parser|source-parser|graph)\.(?:ts|js)$/.test(path))).toEqual([]);
    // Every page module shares one client and runtime chunk, so client navigation keeps one registry.
    const chunks = await Promise.all((await readdir(join(result.outDir, "_htmlkit"))).filter(file => file.endsWith(".js"))
      .map(file => readFile(join(result.outDir, "_htmlkit", file), "utf8")));
    expect(chunks.filter(source => source.includes("hk-announcer"))).toHaveLength(1);
    // Payloads live in the reserved _htmlkit tree and name what the page's document links.
    const payload = JSON.parse(await readFile(join(result.outDir, "_htmlkit/pages/items/one/payload.json"), "utf8"));
    expect(payload.modules).toEqual([manifest.pages[1].browserModule]);
    const itemDocument = await readFile(join(result.outDir, "items/one/index.html"), "utf8");
    expect(payload.styles).toEqual([...itemDocument.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(match => match[1]));
    expect(payload.styles.length).toBeGreaterThan(0);
    expect(payload.layers.map((layer: { component: string }) => layer.component)).toEqual(["items-layout", "item-page"]);
    expect(payload.layers[1].attributes).toEqual({ label: "kit: one", tags: '["a < b","quote \\" here"]', slug: "one" });
    // Shared chunks, which links on screen prefetch, never include a page's own module.
    for (const page of manifest.pages) {
      expect(page.chunks.length).toBeGreaterThan(0);
      expect(page.chunks.every((chunk: string) => /^\/docs\/_htmlkit\/[^/]+\.js$/.test(chunk) && !manifest.pages.some((other: { browserModule: string }) => other.browserModule === chunk))).toBe(true);
    }
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

  it("nests each folder's _layout.html inside its parents' layouts, under the selected layout", async () => {
    const root = await app();
    const shell = (tag: string) => `<template component="${tag}"><defs><prop name="trail" type="string" required>Trail</prop></defs><div from:data-trail="$trail"><slot name="page"></slot></div></template>`;
    await write(root, "app/layouts/admin.html", '<template component="admin-shell"><main><slot name="page"></slot></main></template>');
    await write(root, "app/layouts/admin.server.ts", "export const load = () => ({ data: { owner: 'admin' } });");
    await write(root, "app/pages/docs/_layout.html", shell("docs-shell"));
    await write(root, "app/pages/docs/_layout.server.ts", "export const load = ({ parent }) => ({ props: { trail: parent.owner }, data: { section: 'docs' } });");
    await write(root, "app/pages/docs/index.html", '<template component="docs-page"><p>Docs home</p></template>');
    await write(root, "app/pages/docs/guide/_layout.html", shell("guide-shell"));
    await write(root, "app/pages/docs/guide/_layout.server.ts", "export const load = ({ parent }) => ({ props: { trail: parent.owner + '/' + parent.section }, data: { chapter: 'guide' } });");
    await write(root, "app/pages/docs/guide/intro.html", '<template component="intro-page"><defs><prop name="trail" type="string" required>Trail</prop></defs><p>Intro {$trail}</p></template>');
    await write(root, "app/pages/docs/guide/intro.server.ts", "export const load = ({ parent }) => ({ props: { trail: [parent.owner, parent.section, parent.chapter].join('/') } });");
    await write(root, "app/pages/docs/guide/admin.html", '<template component="admin-page"><defs><meta name="hk:layout" content="admin"></defs><p>Admin</p></template>');
    await write(root, "app/pages/docs/guide/plain.html", '<template component="plain-page"><defs><meta name="hk:layout" content="none"></defs><p>Plain</p></template>');
    const routes = await discoverRoutes(root);
    const chain = (pattern: string) => routes.find(route => route.pattern === pattern)!.layouts.map(layer => [layer.component.slice(root.length), layer.server?.toString().slice(root.length)]);
    expect(routes.some(route => route.pattern.includes("_layout"))).toBe(false);
    expect(chain("/docs/guide/intro/")).toEqual([["/app/layouts/default.html", "/app/layouts/default.server.ts"],
      ["/app/pages/docs/_layout.html", "/app/pages/docs/_layout.server.ts"], ["/app/pages/docs/guide/_layout.html", "/app/pages/docs/guide/_layout.server.ts"]]);
    expect(chain("/docs/")).toHaveLength(2);
    expect(chain("/")).toHaveLength(1);
    // hk:layout replaces the outermost layout only; none drops every layout, folder layouts included.
    expect(chain("/docs/guide/admin/").map(([component]) => component)).toEqual(["/app/layouts/admin.html", "/app/pages/docs/_layout.html", "/app/pages/docs/guide/_layout.html"]);
    expect(chain("/docs/guide/plain/")).toEqual([]);
    const application = await createApplication({ root });
    try {
      // Outer to inner, each loader receives the data of the ones before it as parent.
      const intro = await application.render("/docs/guide/intro/");
      expect(intro.layers.map(layer => layer.component)).toEqual(["app-layout", "docs-shell", "guide-shell", "intro-page"]);
      const order = ["app-layout", "docs-shell", "guide-shell", "intro-page"].map(tag => intro.body.indexOf(`component="${tag}"`));
      expect(order.every((position, i) => position >= 0 && (i === 0 || position > order[i - 1]!))).toBe(true);
      expect(intro.body).toContain('data-trail="kit"');
      expect(intro.body).toContain('data-trail="kit/docs"');
      expect(intro.body).toContain("Intro kit/docs/guide");
      const admin = await application.render("/docs/guide/admin/");
      expect(admin.layers.map(layer => layer.component)).toEqual(["admin-shell", "docs-shell", "guide-shell", "admin-page"]);
      expect(admin.body).toContain('data-trail="admin/docs"');
      expect((await application.render("/docs/guide/plain/")).layers.map(layer => layer.component)).toEqual(["plain-page"]);
    } finally { await application.close(); }
    const result = await buildApplication({ root });
    const built = await readFile(join(result.outDir, "docs/guide/intro/index.html"), "utf8");
    for (const tag of ["app-layout", "docs-shell", "guide-shell"]) expect(built).toContain(`component="${tag}"`);
    expect(built).toContain("Intro kit/docs/guide");
    expect(existsSync(join(result.outDir, "docs/_layout/index.html"))).toBe(false);
  }, 60_000);

  it("renders app/pages/404.html for every unmatched path, through its layout, in each delivery", async () => {
    const root = await app();
    await write(root, "app/pages/404.html", '<template component="not-found-page"><defs><prop name="path" type="string" required>Missing path</prop><title>Lost</title></defs><h1>Nothing at {$path}</h1></template>');
    await write(root, "app/pages/404.server.ts", "export const load = ({ url }) => ({ props: { path: url.pathname } });");
    const application = await createApplication({ root });
    try {
      // The not-found page is no route: it is not served at /404/, listed, or linked from navigation.
      expect(application.routes.some(route => route.pattern === "/404/")).toBe(false);
      expect(application.notFound?.pageName).toBe("not-found-page");
      expect((await application.navigation()).some(item => item.pageName === "not-found-page")).toBe(false);
      const missing = await application.render("/nowhere/");
      expect(missing.status).toBe(404);
      expect(missing.body).toContain("Nothing at /nowhere/");
      expect(missing.body).toContain('component="app-layout"');
      expect(titleOf(missing)).toBe("Lost");
      expect((await application.render("/404/")).status).toBe(404);
      const response = await application.fetch(new Request("http://localhost/nowhere/"));
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("Nothing at /nowhere/");
      expect((await application.fetch(new Request("http://localhost/_htmlkit/pages/nowhere/payload.json"))).status).toBe(404);
    } finally { await application.close(); }
    const result = await buildApplication({ root });
    expect(result.routes).not.toContain("/404/");
    expect(existsSync(join(result.outDir, "404/index.html"))).toBe(false);
    const document = await readFile(join(result.outDir, "404.html"), "utf8");
    expect(document).toContain(">Lost</title>");
    expect(document).toContain('component="app-layout"');
    // A static host serves 404.html at any missing path, so its modules are absolute.
    expect(document).toMatch(/<script type="module" src="\/_htmlkit\/[^"]+\.js"><\/script>/);
    const manifest = JSON.parse(await readFile(join(result.outDir, "_htmlkit/manifest.json"), "utf8"));
    expect(manifest.routes).not.toContain("/404/");
    const server = await previewApplication({ root, port: 0 });
    try {
      const gone = await fetch(server.url + "gone/deeper/");
      expect(gone.status).toBe(404);
      expect(await gone.text()).toContain(">Lost</title>");
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

  it("resolves component packages with import-only exports and ignores their page-wide head entries", async () => {
    const root = await app();
    await write(root, "node_modules/@example/controls/package.json", '{"name":"@example/controls","type":"module","exports":{"./label.html":{"import":"./label.html"},"./controller":{"import":"./controller.js"}}}');
    // Reached by a bare specifier, so an imported component: its canonical link and robots meta are ignored.
    await write(root, "node_modules/@example/controls/label.html", '<template component="package-label" controller="@example/controls/controller"><defs>' +
      '<link rel="canonical" href="https://elsewhere.example/"><meta name="robots" content="noindex"><meta name="description" content="Package description">' +
      '<link rel="preconnect" href="https://cdn.example"></defs><strong>Package component</strong></template>');
    await write(root, "node_modules/@example/controls/controller.js", 'export default () => {};');
    await write(root, "extra/package.html", '<link rel="component" href="@example/controls/label.html"><template component="package-page"><main><package-label></package-label></main></template>');
    const application = await createApplication({ root, fileRoutes: false, routes: [{ pattern: "/", component: "extra/package.html" }] });
    try {
      const page = await application.render("/");
      expect(page.html).toContain("Package component");
      expect(page.head.html).not.toMatch(/elsewhere\.example|noindex/);
      expect(page.head.html).toContain('<meta name="description" content="Package description" data-component-head="">');
      expect(page.head.html).toContain('<link rel="preconnect" href="https://cdn.example" data-component-head="">');
      expect(page.components.find(component => component.definition.contract.tag === "package-label")?.controller).toContain(join("controls", "controller.js"));
    }
    finally { await application.close(); }
  });

  it("updates development pages and loader dependencies and discovers added routes", async () => {
    const root = await app();
    const server = await devApplication({ root, base: "/dev/", port: 0 });
    try {
      expect(await (await fetch(server.url)).text()).toContain("Home &amp; kit");
      await write(root, "app/pages/index.server.ts", "import { title } from './title.ts'; export const load = () => ({ props: { asset: title } });");
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
    await expect(buildApplication({ root })).rejects.toThrow(/request is unavailable while prerendering/);
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
