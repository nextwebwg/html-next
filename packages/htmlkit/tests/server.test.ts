import { existsSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication, createApplication, readManifest, startApplication } from "../src/index.js";
import { fixture, privateFixture, universalFixture, write } from "./fixture.js";

it("keeps built private readers on the server while serving browser reads for prerendered components", async () => {
  const root = await privateFixture(); roots.push(root);
  await write(root, "app/pages/index.server.ts", `export const props = { label: { load(query, context) {
    const privateCode = "PRIVATE_READER_SERVER_CODE";
    if (query === "private-marker") return privateCode;
    return (context.phase === "build" ? "Build" : context.cookies.get("user") || "Guest") + ":" + query;
  } } };`);
  const { outDir } = await buildApplication({ root });
  const publicFiles = (await readdir(join(outDir, "_htmlkit"))).filter(file => file.endsWith(".js"));
  expect(publicFiles.length).toBeGreaterThan(0);
  for (const file of publicFiles) expect(await readFile(join(outDir, "_htmlkit", file), "utf8")).not.toContain("PRIVATE_READER_SERVER_CODE");
  const serverFiles = (await readdir(join(outDir, "_htmlkit/server"))).filter(file => file.endsWith(".js"));
  const privateFiles = await Promise.all(serverFiles.map(async file => [file, await readFile(join(outDir, "_htmlkit/server", file), "utf8")] as const));
  const privateFile = privateFiles.find(([, source]) => source.includes("PRIVATE_READER_SERVER_CODE"))?.[0];
  expect(privateFile).toBeDefined();
  const payload = JSON.parse(await readFile(join(outDir, "_htmlkit/pages/payload.json"), "utf8"));
  const rendered = await readFile(join(outDir, "index.html"), "utf8");
  expect(rendered).toContain("Build:A");
  const escaped = /data-htmlkit-bindings="([^"]+)"/.exec(rendered)![1]!.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  const source = JSON.parse(escaped)["client-page"].source as string;
  expect(JSON.stringify(payload)).not.toContain("PRIVATE_READER_SERVER_CODE");
  const server = await startApplication({ outDir, port: 0 });
  try {
    const response = await fetch(server.url + "_htmlkit/read", { method: "POST", headers: { "content-type": "application/json", cookie: "user=Ada" }, body: JSON.stringify({
      version: 1, source, tag: "client-page", name: "label", url: server.url,
      inputs: ["json", { props: {}, state: { query: "B" } }],
    }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ value: ["value", "Ada:B"] });
    expect((await fetch(server.url + "_htmlkit/server/" + privateFile)).status).toBe(404);
  } finally { await server.close(); }
}, 120_000);

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

for (const delivery of ["application", "start"] as const) {
  it(`${delivery} owns provider workers independently and can restart the same application`, async () => {
    const root = await universalFixture(); roots.push(root);
    let accepted!: (response: ServerResponse) => void;
    const reading = new Promise<ServerResponse>(resolve => { accepted = resolve; });
    const backend = createServer((_request, response) => accepted(response));
    await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
    const address = backend.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP listener.");
    await write(root, "lib/product.ts", `export function create() { return { props: { product: {
      input: (_, { state }) => state.query,
      async load(query, { phase, signal }) {
        return { name: query === "hold" ? await (await fetch(${JSON.stringify(`http://127.0.0.1:${address.port}`)}, { signal })).text() : phase + ":" + query };
      }
    } } }; }`);
    const outDir = delivery === "start" ? (await buildApplication({ root })).outDir : undefined;
    const open = async () => {
      if (delivery === "application") {
        const application = await createApplication({ root });
        return { close: () => application.close(), fetch: (query: string) => application.fetch(new Request(`http://localhost/live/?q=${query}`)) };
      }
      const server = await startApplication({ outDir: outDir!, port: 0, renderWorkers: 1 });
      return { close: () => server.close(), fetch: (query: string) => fetch(`${server.url}live/?q=${query}`) };
    };
    const first = await open(); const second = await open();
    let pending: Promise<Response> | undefined;
    try {
      expect(await (await first.fetch("first")).text()).toContain("<h1>request:first</h1>");
      pending = second.fetch("hold");
      const response = await reading;
      await first.close();
      response.end("Other application");
      const completed = await pending;
      expect(completed.status).toBe(200);
      expect(await completed.text()).toContain("<h1>Other application</h1>");
      expect(await (await second.fetch("second")).text()).toContain("<h1>request:second</h1>");
      const restarted = await open();
      try { expect(await (await restarted.fetch("restart")).text()).toContain("<h1>request:restart</h1>"); }
      finally { await restarted.close(); }
    } finally {
      backend.closeAllConnections();
      await Promise.all([first.close(), second.close(), new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve()))]);
      await pending?.catch(() => {});
    }
  }, 120_000);
}

/** The basic fixture plus server-rendered pages, endpoints, and middleware. */
async function serverApp(): Promise<string> {
  const root = await fixture();
  roots.push(root);
  await write(root, "app/pages/account.html", `<template component="account-page"><defs>
    <prop name="user" type="string" required>User</prop><prop name="page" type="string" required>Page</prop><prop name="trace" type="string" required>Trace</prop><meta name="hk:render" content="server"><title>Account</title></defs>
    <section><h1>{$user}</h1><p class="page">{$page}</p><p class="trace">{$trace}</p></section></template>`);
  await write(root, "app/pages/account.server.ts", `export function load({ phase, url, cookies, request, response, redirect, notFound }) {
    if (phase !== "request") throw new Error("Rendered at build time");
    if (url.searchParams.has("missing")) notFound();
    const user = cookies.get("user");
    if (user === undefined) { response.headers.append("set-cookie", "visited=1; Path=/"); redirect("/login/"); }
    if (url.searchParams.has("teapot")) response.status = 418;
    response.headers.set("cache-control", "private, no-store");
    response.headers.append("set-cookie", "seen=" + user + "; Path=/; HttpOnly");
    response.headers.append("set-cookie", "theme=dark; Path=/");
    return { props: { user, page: url.searchParams.get("page") ?? "1", trace: request.headers.get("x-trace") ?? "none" } };
  }`);
  // The build's link check counts server-rendered pages and endpoints, which have no file, as whole.
  await write(root, "app/pages/login.html", '<template component="login-page"><defs><title>Log in</title></defs><p>Log in, then see <a href="/account/">your account</a>, <a href="/users/grace/">Grace</a>, or <a href="/api/todos">the API</a>.</p></template>');
  await write(root, "app/pages/users/[id].html", `<template component="user-page"><defs>
    <prop name="name" type="string" required>Name</prop><meta name="hk:render" content="server"></defs><p class="user">{$name}</p></template>`);
  await write(root, "app/pages/users/[id].server.ts", 'export const load = ({ params, notFound }) => params.id === "ghost" ? notFound() : { props: { name: params.id } };');
  await write(root, "app/pages/admin.html", '<template component="admin-page"><defs><meta name="hk:render" content="server"></defs><p>Admin</p></template>');
  await write(root, "app/pages/admin.server.ts", 'export const load = () => { throw new Error("The admin loader ran"); };');
  await write(root, "app/middleware.server.ts", `export default async function middleware(request, next) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/admin/")) return new Response("Members only", { status: 401 });
    if (url.pathname === "/old-account/") return next("/account/" + url.search);
    const headers = new Headers(request.headers);
    headers.set("x-trace", "middleware");
    const response = await next(new Request(request, { headers }));
    response.headers.set("x-middleware", "after");
    return response;
  }`);
  await write(root, "app/api/todos.server.ts", `const todos = [{ id: "1", title: "Write" }];
    export const GET = () => Response.json(todos);
    export async function POST(request) { const todo = await request.json(); todos.push(todo); return Response.json(todo, { status: 201 }); }`);
  await write(root, "app/api/todos/[id].server.ts", `export const GET = (request, { params }) => params.id === "1" ? Response.json({ id: params.id }) : new Response(null, { status: 404 });
    export const DELETE = () => new Response(null, { status: 204 });`);
  await write(root, "app/api/fail.server.ts", 'export const GET = () => { throw new Error("database secret"); };');
  await write(root, "app/error.html", '<template component="error-page"><defs><prop name="status" type="number" required>Status</prop><prop name="message" type="string" required>Reason</prop><title>Trouble</title></defs><section><h1>{$status}</h1><p>{$message}</p></section></template>');
  // Form actions: a validation error renders the page with the submitted value, and success redirects.
  await write(root, "app/pages/todos.html", `<template component="todos-page"><defs>
    <prop name="todos" type="list(string)" required>Todos</prop><prop name="parent" type="string" default="">Parent data</prop>
    <prop name="errors" type="object({ title?: string })" default="{}">Field errors</prop><prop name="values" type="object({ title?: string })" default="{}">Submitted values</prop>
    <meta name="hk:render" content="server"><title>Todos</title></defs><section>
    <form method="post" action="?/create"><input name="title" from:value="$values.title"><p class="error" $if="$errors.title">{$errors.title}</p><button>Add</button></form>
    <ul><li $each="todo of $todos">{$todo}</li></ul><p class="parent">{$parent}</p></section></template>`);
  await write(root, "app/pages/todos.server.ts", `const todos = ["Write"];
    export const load = ({ parent }) => ({ props: { todos, parent: parent.owner } });
    export const actions = {
      async create({ request, response, parent }) {
        if (Object.keys(parent).length > 0) throw new Error("Actions run before every loader");
        const title = String((await request.formData()).get("title") ?? "").trim();
        if (title.length < 3) { response.status = 422; return { errors: { title: "Use at least 3 characters." }, values: { title } }; }
        todos.push(title);
      },
      clear({ redirect, response }) { todos.length = 0; response.headers.append("set-cookie", "cleared=1; Path=/"); redirect("/todos/?cleared"); },
      gone({ notFound }) { notFound(); },
      wrong() { return "no"; },
    };`);
  await write(root, "app/api/go.server.ts", 'export const GET = request => Response.redirect(new URL("/login/", request.url), 307);');
  await write(root, "app/api/feed.xml.server.ts", 'export const GET = () => new Response("<feed/>", { headers: { "content-type": "application/xml" } });');
  return root;
}

type Answer = (path: string, init?: RequestInit) => Promise<Response>;

/** The request behavior Application.fetch and the built server share. */
async function answersRequests(answer: Answer, host: string): Promise<void> {
  const signedIn = { headers: { cookie: "user=ada; theme=light" } };
  // Loaders read the query, cookies, and request headers, and set the status and headers.
  const account = await answer("/account/?page=2", signedIn);
  expect([account.status, account.headers.get("cache-control"), account.headers.get("x-middleware")]).toEqual([200, "private, no-store", "after"]);
  expect(account.headers.getSetCookie()).toEqual(["seen=ada; Path=/; HttpOnly", "theme=dark; Path=/"]);
  const html = await account.text();
  expect(html).toContain("<h1>ada</h1>");
  expect(html).toContain('<p class="page">2</p>');
  // Middleware runs first, and the loader reads the request it passed on.
  expect(html).toContain('<p class="trace">middleware</p>');
  expect(html).toContain("<header>HTMLKit</header>");
  expect((await answer("/account/?teapot", signedIn)).status).toBe(418);
  // redirect() answers 303 and keeps the cookie set before it.
  const anonymous = await answer("/account/");
  expect([anonymous.status, anonymous.headers.get("location"), anonymous.headers.getSetCookie()]).toEqual([303, "/login/", ["visited=1; Path=/"]]);
  // notFound() renders the not-found page with 404.
  const missing = await answer("/account/?missing", signedIn);
  expect(missing.status).toBe(404);
  expect(await missing.text()).toContain("Page not found");
  // A server-rendered dynamic page renders whatever its URL names, without entries().
  expect(await (await answer("/users/grace/")).text()).toMatch(/class="user"[^>]*>grace<\/p>/);
  expect((await answer("/users/ghost/")).status).toBe(404);
  // Middleware answers before any loader runs, and rewrites to another page.
  const admin = await answer("/admin/");
  expect([admin.status, await admin.text()]).toEqual([401, "Members only"]);
  expect(await (await answer("/old-account/?page=3", signedIn)).text()).toContain('<p class="page">3</p>');
  // The payload renders the same page for client navigation, query and cookies included.
  const payload = await answer("/_htmlkit/pages/account/payload.json?page=5", signedIn);
  expect([payload.status, payload.headers.get("content-type")]).toEqual([200, "application/json"]);
  expect((await payload.json()).layers[1]).toMatchObject({ component: "account-page", attributes: { user: "ada", page: "5", trace: "middleware" } });
  expect((await answer("/_htmlkit/pages/account/payload.json")).status).toBe(404);
  // Two requests at once keep their own cookies.
  const [first, second] = await Promise.all(["ada", "bob"].map(async user => (await answer("/account/", { headers: { cookie: `user=${user}` } })).text()));
  expect([first!.includes("<h1>ada</h1>") && !first!.includes("bob"), second!.includes("<h1>bob</h1>") && !second!.includes("ada")]).toEqual([true, true]);
  // Prerendered pages answer through middleware too; pages accept GET and HEAD.
  const prerendered = await answer("/items/one/");
  expect([prerendered.status, prerendered.headers.get("x-middleware")]).toEqual([200, "after"]);
  expect(await prerendered.text()).toContain("kit: one");
  expect((await answer("/login/", { method: "POST" })).status).toBe(405);

  // Form actions answer a POST to their page: a redirect to the page on success, or the page with the action's props.
  const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    answer(path, { method: "POST", body: new URLSearchParams(fields), headers });
  const added = await post("/todos/?/create", { title: "Test" }, { origin: `http://${host}` });
  expect([added.status, added.headers.get("location")]).toEqual([303, "/todos/"]);
  expect(await (await answer("/todos/")).text()).toMatch(/<li>Write<\/li>.*<li>Test<\/li>/);
  const invalid = await post("/todos/?/create&view=all", { title: " ab " }, { "sec-fetch-site": "same-origin" });
  const form = await invalid.text();
  expect([invalid.status, /<input name="title"[^>]* value="ab"/.test(form), form.includes("Use at least 3 characters."), form.includes('class="parent"')]).toEqual([422, true, true, true]);
  // Loaders run after the action and keep their props; layouts render as on GET.
  expect([form.includes(">kit</p>"), form.includes("<header>HTMLKit</header>")]).toEqual([true, true]);
  // A multipart body, as an enhanced submission sends, reads the same.
  const multipart = new FormData();
  multipart.set("title", "ok");
  expect((await answer("/todos/?/create", { method: "POST", body: multipart })).status).toBe(422);
  const cleared = await post("/todos/?/clear", {});
  expect([cleared.status, cleared.headers.get("location"), cleared.headers.getSetCookie()]).toEqual([303, "/todos/?cleared", ["cleared=1; Path=/"]]);
  expect((await post("/todos/?/gone", {})).status).toBe(404);
  // A page answers only the actions it exports, and POST only with actions.
  expect((await post("/todos/", {})).status).toBe(404);
  expect((await post("/todos/?/missing", {})).status).toBe(404);
  expect((await post("/account/", {}, signedIn.headers)).status).toBe(405);
  expect((await answer("/todos/", { method: "PUT" })).status).toBe(405);
  // Cross-site submissions are refused before the action runs, by Sec-Fetch-Site or Origin.
  expect((await post("/todos/?/clear", {}, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await post("/todos/?/clear", {}, { "sec-fetch-site": "same-site" })).status).toBe(403);
  expect((await post("/todos/?/clear", {}, { origin: "https://attacker.example" })).status).toBe(403);
  expect((await post("/todos/?/clear", {}, { origin: "null" })).status).toBe(403);
  expect((await post("/todos/?/create", { title: "Kept" }, { origin: `https://${host}` })).status).toBe(303);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  expect((await post("/todos/?/wrong", {})).status).toBe(500);
  logged.mockRestore();

  // Endpoints answer each exported method with its Response, HEAD through GET, and 405 with Allow otherwise.
  expect(await (await answer("/api/todos")).json()).toEqual([{ id: "1", title: "Write" }]);
  const created = await answer("/api/todos", { method: "POST", body: JSON.stringify({ id: "2", title: "Test" }), headers: { "content-type": "application/json" } });
  expect([created.status, await created.json()]).toEqual([201, { id: "2", title: "Test" }]);
  expect(await (await answer("/api/todos")).json()).toHaveLength(2);
  const head = await answer("/api/todos", { method: "HEAD" });
  expect([head.status, head.headers.get("content-type"), await head.text()]).toEqual([200, "application/json", ""]);
  const put = await answer("/api/todos", { method: "PUT" });
  expect([put.status, put.headers.get("allow")]).toEqual([405, "GET, HEAD, POST"]);
  expect(await (await answer("/api/todos/1")).json()).toEqual({ id: "1" });
  expect((await answer("/api/todos/9")).status).toBe(404);
  expect((await answer("/api/todos/1", { method: "DELETE" })).status).toBe(204);
  const patch = await answer("/api/todos/1", { method: "PATCH" });
  expect([patch.status, patch.headers.get("allow")]).toEqual([405, "GET, HEAD, DELETE"]);
  expect((await answer("/api/todos/")).status).toBe(404);
  const feed = await answer("/api/feed.xml");
  expect([feed.headers.get("content-type"), feed.headers.get("x-middleware"), await feed.text()]).toEqual(["application/xml", "after", "<feed/>"]);
  // A failing endpoint answers with app/error.html through the layout; the error itself goes to the console.
  const failing = vi.spyOn(console, "error").mockImplementation(() => {});
  const failure = await answer("/api/fail");
  const trouble = await failure.text();
  expect([failure.status, trouble.includes("<h1>500</h1><p>Internal Server Error</p>"), trouble.includes("<header>HTMLKit</header>"), trouble.includes("secret")]).toEqual([500, true, true, false]);
  failing.mockRestore();
  // Middleware sets headers on any response next() answers, Response.redirect()'s included.
  const go = await answer("/api/go", { redirect: "manual" });
  expect([go.status, go.headers.get("location")?.endsWith("/login/"), go.headers.get("x-middleware")]).toEqual([307, true, "after"]);
}

describe("request-time rendering", () => {
  it("answers server pages, endpoints, and middleware through application.fetch", async () => {
    const root = await serverApp();
    const application = await createApplication({ root });
    try {
      expect(application.routes.find(route => route.pageName === "account-page")!.render).toBe("server");
      expect(application.routes.find(route => route.pageName === "login-page")!.render).toBeUndefined();
      expect(application.endpoints.map(endpoint => endpoint.pattern)).toEqual(["/api/fail", "/api/feed.xml", "/api/go", "/api/todos/[id]", "/api/todos"]);
      expect(application.middleware).toBe(join(root, "app/middleware.server.ts"));
      // Server-rendered pages render on request, so a build lists only prerendered ones.
      expect(await application.entries()).not.toContain("/account/");
      await answersRequests((path, init) => application.fetch(new Request(`http://localhost${path}`, init)), "localhost");
    } finally { await application.close(); }
  }, 120_000);

  it("builds a server entry that htmlkit start serves over HTTP, with prerendered pages from files", async () => {
    const root = await serverApp();
    const { outDir, routes } = await buildApplication({ root });
    // Per-route mode: server-rendered pages have no file, and prerendered pages have theirs.
    expect(routes).toEqual(["/", "/items/one/", "/items/two/", "/login/"]);
    expect((await readManifest(outDir)).routes).toEqual(routes);
    for (const path of ["account", "users", "admin", "api"]) expect(existsSync(join(outDir, path))).toBe(false);
    for (const path of ["index.html", "login/index.html", "404.html", "_htmlkit/server/entry.js", "_htmlkit/server/middleware.js"]) expect(existsSync(join(outDir, path))).toBe(true);
    const entry = await readFile(join(outDir, "_htmlkit/server/entry.js"), "utf8");
    // Diagnostics name loader files relative to the root, which the server need not have.
    expect(entry).toContain('origin\\":\\"app/pages/account.server.ts');
    expect(entry).not.toContain(join(root, "app/pages/account.server.ts"));
    const server = await startApplication({ outDir, port: 0 });
    try {
      const url = server.url.slice(0, -1);
      await answersRequests((path, init) => fetch(url + path, { ...init, redirect: "manual" }), new URL(url).host);
      // A server-rendered page loads its own browser bundle, as a prerendered one does.
      const page = await (await fetch(`${url}/account/`, { headers: { cookie: "user=ada" } })).text();
      const module = /<script type="module" src="([^"]+)"/.exec(page)![1]!;
      const asset = await fetch(url + module);
      expect([asset.status, asset.headers.get("content-type"), asset.headers.get("cache-control")])
        .toEqual([200, "text/javascript; charset=utf-8", "public, max-age=31536000, immutable"]);
      // Files answer before middleware; the server's own code is never served.
      const mark = await fetch(`${url}/mark.svg`);
      expect([mark.status, mark.headers.get("content-type"), mark.headers.get("x-middleware")]).toEqual([200, "image/svg+xml", null]);
      expect((await fetch(`${url}/_htmlkit/server/entry.js`)).status).toBe(404);
      expect((await fetch(`${url}/_htmlkit/manifest.json`)).headers.get("cache-control")).toBeNull();
      const notFound = await fetch(`${url}/nowhere/`);
      expect([notFound.status, notFound.headers.get("x-middleware")]).toEqual([404, "after"]);
      expect(await notFound.text()).toBe(await readFile(join(outDir, "404.html"), "utf8"));
      expect((await fetch(`${url}/login`, { redirect: "manual" })).headers.get("location")).toBe("/login/");
    } finally { await server.close(); }
  }, 180_000);

  it("answers with the error page when a render worker ends mid-render, and renders the next request on a new one", async () => {
    const root = await fixture();
    roots.push(root);
    await write(root, "app/pages/live.html", '<template component="live-page"><defs><meta name="hk:render" content="server"><title>Live</title><prop name="label" type="string">Label.</prop><state name="query" type="string" value="Live"></state></defs><section><p $await="$label">{$label}</p></section></template>');
    await write(root, "app/pages/live.server.ts", 'export const load = ({ url }) => ({ state: { query: url.searchParams.has("crash") ? "crash" : "Live" } });');
    await write(root, "app/pages/live.ts", 'export const props = { label: { input: (_, { state }) => state.query, load: (query, { phase }) => { if (phase === "request" && query === "crash") process.exit(1); return query; } } };');
    const { outDir } = await buildApplication({ root });
    const server = await startApplication({ outDir, port: 0, renderWorkers: 2 });
    try {
      const url = server.url + "live/";
      const lost = await fetch(url + "?crash");
      expect([lost.status, await lost.text()]).toEqual([500, expect.stringContaining("<h1>Internal Server Error</h1>")]);
      const next = await fetch(url);
      expect([next.status, (await next.text()).includes("<p")]).toEqual([200, true]);
    } finally {
      await server.close();
    }
  }, 120_000);

  it("keeps a static build's output and adds only the server entry", async () => {
    const root = await fixture();
    roots.push(root);
    const { outDir } = await buildApplication({ root, redirects: { "/old/": "/items/one/" } });
    // No loader, endpoint, or middleware runs at request time, so the server holds no application code.
    expect(await readdir(join(outDir, "_htmlkit/server"))).toEqual(["entry.js"]);
    const server = await startApplication({ outDir, port: 0 });
    try {
      const url = server.url.slice(0, -1);
      expect(await (await fetch(`${url}/`)).text()).toBe(await readFile(join(outDir, "index.html"), "utf8"));
      expect(await (await fetch(`${url}/_htmlkit/pages/items/one/payload.json`)).json()).toMatchObject({ version: 1 });
      // A redirect page's URL answers with the redirect itself.
      const old = await fetch(`${url}/old/`, { redirect: "manual" });
      expect([old.status, old.headers.get("location")]).toEqual([308, "/items/one/"]);
      expect((await fetch(`${url}/missing/`)).status).toBe(404);
    } finally { await server.close(); }
  }, 120_000);

  it("diagnoses server-only inputs while prerendering and misplaced server files", async () => {
    const root = await fixture();
    roots.push(root);
    await write(root, "app/pages/index.server.ts", "export const load = ({ cookies }) => ({ props: { asset: cookies.get('a') } });");
    await expect(buildApplication({ root })).rejects.toThrow(/index\.server\.ts: cookies is unavailable while prerendering; <meta name="hk:render" content="server">/);
    await write(root, "app/pages/index.server.ts", "export const load = ({ response }) => { response.status = 201; return {}; };");
    await expect(buildApplication({ root })).rejects.toThrow(/response is unavailable while prerendering/);
    // Actions answer requests, so a prerendered page has none, in a build and in development.
    await write(root, "app/pages/index.server.ts", "export const load = () => ({ props: { asset: '/mark.svg' } }); export const actions = { default() {} };");
    await expect(buildApplication({ root })).rejects.toThrow(/index\.server\.ts: The page \/ has actions, which answer requests; <meta name="hk:render" content="server">/);
    const prerendered = await createApplication({ root });
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await prerendered.fetch(new Request("http://localhost/", { method: "POST" }))).status).toBe(500);
      expect(reported).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/The page \/ has actions/) }));
    } finally { reported.mockRestore(); await prerendered.close(); }
    await write(root, "app/pages/index.server.ts", "export const load = () => ({ props: { asset: '/mark.svg' } });");
    await write(root, "app/pages/items/[slug].server.ts", "export const entries = () => [{ slug: 'one' }, { slug: 'gone' }]; export const load = ({ params, notFound }) => params.slug === 'gone' ? notFound() : ({ props: { label: params.slug, tags: [], slug: params.slug } });");
    // A prerendered entry whose loader calls notFound() is left out of the build.
    const { outDir, routes } = await buildApplication({ root });
    expect(routes).toEqual(["/", "/items/one/"]);
    expect(existsSync(join(outDir, "items/gone"))).toBe(false);
    await write(root, "app/pages/404.html", '<template component="missing-page"><defs><meta name="hk:render" content="server"></defs><p>Gone</p></template>');
    await expect(createApplication({ root })).rejects.toThrow(/not-found page takes no hk:render/);
    await rm(join(root, "app/pages/404.html"));
    await write(root, "app/pages/login.html", '<template component="login-page"><defs><meta name="hk:render" content="sometimes"></defs><p>Log in</p></template>');
    await expect(createApplication({ root })).rejects.toThrow(/hk:render accepts content="prerender" or content="server"/);
    await rm(join(root, "app/pages/login.html"));
    await write(root, "app/middleware.server.js", "export default (request, next) => next();");
    await write(root, "app/middleware.server.ts", "export default (request, next) => next();");
    await expect(createApplication({ root })).rejects.toThrow(/Choose one app\/middleware\.server\.ts or \.js/);
    await rm(join(root, "app/middleware.server.js"));
    await write(root, "app/middleware.server.ts", "export default () => 'no';");
    const application = await createApplication({ root });
    // A failure answers with the error page, and the error goes to the console.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await application.fetch(new Request("http://localhost/"))).status).toBe(500);
      expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/Middleware must return a Response/) }));
    }
    finally { await application.close(); }
    await rm(join(root, "app/middleware.server.ts"));
    await write(root, "app/api/todos.server.ts", "export const GET = () => 'no';");
    await write(root, "app/api/todos/index.server.ts", "export const GET = () => new Response();");
    await expect(createApplication({ root })).rejects.toThrow(/Endpoint conflict/);
    await rm(join(root, "app/api/todos"), { recursive: true });
    const endpoint = await createApplication({ root });
    try {
      expect((await endpoint.fetch(new Request("http://localhost/api/todos"))).status).toBe(500);
      expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/todos\.server\.ts: GET must return a Response/) }));
    } finally { await endpoint.close(); logged.mockRestore(); }
  }, 180_000);
});
