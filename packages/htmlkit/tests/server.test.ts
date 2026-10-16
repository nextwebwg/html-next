import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { closeRenderWorkers, setRenderWorkers } from "../../html-next/src/server.js";
import { buildApplication, createApplication, readManifest, startApplication } from "../src/index.js";
import { fixture, write } from "./fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

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
  await write(root, "app/api/go.server.ts", 'export const GET = request => Response.redirect(new URL("/login/", request.url), 307);');
  await write(root, "app/api/feed.xml.server.ts", 'export const GET = () => new Response("<feed/>", { headers: { "content-type": "application/xml" } });');
  return root;
}

type Answer = (path: string, init?: RequestInit) => Promise<Response>;

/** The request behavior Application.fetch and the built server share. */
async function answersRequests(answer: Answer): Promise<void> {
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
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const failure = await answer("/api/fail");
  const trouble = await failure.text();
  expect([failure.status, trouble.includes("<h1>500</h1><p>Internal Server Error</p>"), trouble.includes("<header>HTMLKit</header>"), trouble.includes("secret")]).toEqual([500, true, true, false]);
  logged.mockRestore();
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
      await answersRequests((path, init) => application.fetch(new Request(`http://localhost${path}`, init)));
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
      await answersRequests((path, init) => fetch(url + path, { ...init, redirect: "manual" }));
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
    await write(root, "app/pages/live.html", '<template component="live-page"><defs><meta name="hk:render" content="server"><title>Live</title></defs><p>Live</p></template>');
    // The page's loader is the last one, so its render is under way by the next macrotask.
    await write(root, "app/pages/live.server.ts", "export const load = () => { globalThis.endRenderWorkers?.(); return {}; };");
    const { outDir } = await buildApplication({ root });
    const server = await startApplication({ outDir, port: 0, renderWorkers: 2 });
    const hooks = globalThis as { endRenderWorkers?: (() => void) | undefined };
    try {
      const url = server.url + "live/";
      hooks.endRenderWorkers = () => { hooks.endRenderWorkers = undefined; setImmediate(() => void closeRenderWorkers()); };
      const lost = await fetch(url);
      expect([lost.status, await lost.text()]).toEqual([500, expect.stringContaining("<h1>Internal Server Error</h1>")]);
      const next = await fetch(url);
      expect([next.status, (await next.text()).includes("<p")]).toEqual([200, true]);
    } finally {
      hooks.endRenderWorkers = undefined;
      setRenderWorkers(Math.min(availableParallelism(), 8));
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
