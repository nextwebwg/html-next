import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildApplication, createApplication, devApplication, discoverRoutes, readManifest } from "../src/index.js";
import { write } from "./fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function site(pages: Readonly<Record<string, string>>) {
  const root = await mkdtemp(join(tmpdir(), "hk-routing-")); roots.push(root);
  await write(root, "package.json", '{"type":"module"}');
  await write(root, "app/pages/index.html", '<template component="page-home"><h1>Home</h1></template>');
  for (const [file, contents] of Object.entries(pages)) await write(root, `app/pages/${file}`, contents);
  return root;
}
// A page that shows its params as JSON.
const echo = (name: string) => `<template component="${name}"><defs><prop name="params" type="string" default="none">Params</prop></defs><p>${name} {$params}</p></template>`;
const echoLoader = (entries: string) => `export const entries = () => ${entries};
  export const load = ({ params }) => ({ props: { params: JSON.stringify(params) } });`;

it("matches [...name] and [[...name]] catch-alls with list params, after literal and [name] routes", async () => {
  const root = await site({
    "docs/static.html": echo("page-static"),
    "docs/[id].html": echo("page-id"), "docs/[id].server.ts": echoLoader('[{ id: "x" }]'),
    "docs/[...path].html": echo("page-path"), "docs/[...path].server.ts": echoLoader('[{ path: ["a", "b"] }, { path: ["c d", "e"] }]'),
    "files/[[...rest]].html": echo("page-rest"), "files/[[...rest]].server.ts": echoLoader('[{ rest: [] }, { rest: ["deep", "er"] }]'),
    // At the same position, a catch-all precedes an optional catch-all.
    "mix/[...some].html": echo("page-some"), "mix/[...some].server.ts": echoLoader("[]"), "mix/[[...any]].html": echo("page-any"), "mix/[[...any]].server.ts": echoLoader("[]"),
  });
  const application = await createApplication({ root, base: "/kit/" });
  try {
    expect(application.routes.find(route => route.pageName === "page-path")!.params).toEqual(["path"]);
    const matched = async (path: string) => />(page-[a-z]+) (.*?)<\/p>/.exec((await application.render(path)).body)?.slice(1).map(text => text.replaceAll("&quot;", '"'));
    expect(await matched("/kit/docs/static/")).toEqual(["page-static", "none"]);
    expect(await matched("/kit/docs/x/")).toEqual(["page-id", '{"id":"x"}']);
    expect(await matched("/kit/docs/a/b/")).toEqual(["page-path", '{"path":["a","b"]}']);
    // Dynamic pages render on request without being listed in entries().
    expect(await matched("/kit/docs/q/r/s/")).toEqual(["page-path", '{"path":["q","r","s"]}']);
    expect(await matched("/kit/files/")).toEqual(["page-rest", '{"rest":[]}']);
    expect(await matched("/kit/files/deep/er/")).toEqual(["page-rest", '{"rest":["deep","er"]}']);
    expect(await matched("/kit/mix/")).toEqual(["page-any", '{"any":[]}']);
    expect(await matched("/kit/mix/a/")).toEqual(["page-some", '{"some":["a"]}']);
    expect((await application.render("/kit/docs/")).status).toBe(404);
  } finally { await application.close(); }
  await rm(join(root, "app/pages/mix"), { recursive: true });
  const built = await createApplication({ root, base: "/kit/" });
  try {
    expect(await built.entries()).toEqual(["/kit/", "/kit/docs/a/b/", "/kit/docs/c%20d/e/", "/kit/docs/static/", "/kit/docs/x/", "/kit/files/", "/kit/files/deep/er/"]);
  } finally { await built.close(); }
  const result = await buildApplication({ root, base: "/kit/" });
  expect(await readFile(join(result.outDir, "docs/a/b/index.html"), "utf8")).toContain("page-path");
  expect(await readFile(join(result.outDir, "files/index.html"), "utf8")).toContain("page-rest");
}, 60_000);

it("diagnoses a catch-all before another segment and entries that aren't segment lists", async () => {
  const root = await site({ "docs/[...path].html": echo("page-path"), "docs/[...path].server.ts": echoLoader('[{ path: "a/b" }]') });
  await expect(discoverRoutes(root, { routes: [{ pattern: "/x/[...rest]/edit/", component: "app/pages/index.html" }] }))
    .rejects.toThrow(/catch-all.*last route segment/);
  const application = await createApplication({ root });
  try { await expect(application.entries()).rejects.toThrow(/path must be a nonempty list of safe nonempty URL segments/); }
  finally { await application.close(); }
  await write(root, "app/pages/docs/[...path].server.ts", echoLoader("[{ path: [] }]"));
  const empty = await createApplication({ root });
  try { await expect(empty.entries()).rejects.toThrow(/nonempty list/); }
  finally { await empty.close(); }
  // An entry whose URL a more specific route matches would build a page no request reaches.
  await write(root, "app/pages/docs/[...path].server.ts", echoLoader('[{ path: ["one"] }]'));
  await write(root, "app/pages/docs/[id].html", echo("page-id"));
  await write(root, "app/pages/docs/[id].server.ts", echoLoader('[{ id: "x" }]'));
  const shadowed = await createApplication({ root });
  try { await expect(shadowed.entries()).rejects.toThrow(/Static route collision with \/docs\/\[id\]\/ at \/docs\/one\//); }
  finally { await shadowed.close(); }
});

it("redirects from the redirects table and from loaders, in fetch, render, and the development server", async () => {
  const root = await site({
    "docs/static.html": echo("page-static"),
    "account.html": echo("page-account"), "account.server.ts": 'export const load = ({ redirect }) => redirect("/docs/static/");',
    "moved.html": echo("page-moved"), "moved.server.ts": 'export const load = ({ redirect }) => redirect("https://example.com/moved/", 301);',
  });
  const redirects = { "/old/": "/docs/static/", "/old/deeper/": "https://example.com/" };
  const application = await createApplication({ root, base: "/kit/", redirects });
  try {
    const answer = async (path: string) => {
      const response = await application.fetch(new Request(`http://localhost${path}`));
      return [response.status, response.headers.get("location")];
    };
    expect(await answer("/kit/old/")).toEqual([308, "/kit/docs/static/"]);
    // Without the trailing slash, the redirect is still one hop.
    expect(await answer("/kit/old")).toEqual([308, "/kit/docs/static/"]);
    expect(await answer("/kit/old/deeper/")).toEqual([308, "https://example.com/"]);
    expect(await answer("/kit/account/")).toEqual([303, "/kit/docs/static/"]);
    expect(await answer("/kit/moved/")).toEqual([301, "https://example.com/moved/"]);
    const page = await application.render("/kit/account/");
    expect([page.status, page.location]).toEqual([303, "/kit/docs/static/"]);
    expect(page.html).toContain('<meta http-equiv="refresh" content="0; url=/kit/docs/static/">');
    expect(page.html).toContain('<link rel="canonical" href="/kit/docs/static/">');
    expect(page.html).toContain('<a href="/kit/docs/static/">');
    // Client navigation finds no payload and loads the redirecting URL itself.
    expect((await application.fetch(new Request("http://localhost/kit/_htmlkit/pages/account/payload.json"))).status).toBe(404);
  } finally { await application.close(); }
  for (const [table, message] of [[{ "old/": "/x/" }, /leading and trailing slashes/], [{ "/_htmlkit/x/": "/x/" }, /outside _htmlkit/],
    [{ "/old/": "//evil.example/" }, /application path starting with \/ or an http\(s\) URL/], [{ "/old/": "javascript:alert(1)" }, /http\(s\) URL/]] as const) {
    await expect(createApplication({ root, redirects: table })).rejects.toThrow(message);
  }
  await write(root, "app/pages/bad.server.ts", 'export const load = ({ redirect }) => redirect("/x/", 200);');
  await write(root, "app/pages/bad.html", echo("page-bad"));
  const bad = await createApplication({ root });
  try { await expect(bad.render("/bad/")).rejects.toThrow(/Redirect status 200 must be 301, 302, 303, 307, or 308/); }
  finally { await bad.close(); }
  await rm(join(root, "app/pages/bad.html"));
  const server = await devApplication({ root, port: 0, redirects });
  try {
    for (const [path, status, location] of [["old/", 308, "/docs/static/"], ["account/", 303, "/docs/static/"]] as const) {
      const response = await fetch(server.url + path, { redirect: "manual" });
      expect([response.status, response.headers.get("location")]).toEqual([status, location]);
    }
  } finally { await server.close(); }
}, 60_000);

it("writes a redirect page at each old URL and lists redirects in the manifest", async () => {
  const root = await site({
    "docs/static.html": echo("page-static"),
    "account.html": echo("page-account"), "account.server.ts": 'export const load = ({ redirect }) => redirect("/docs/static/", 307);',
  });
  const result = await buildApplication({ root, base: "/kit/", redirects: { "/old/": "/docs/static/", "/a/b/": "https://example.com/b/" } });
  const old = await readFile(join(result.outDir, "old/index.html"), "utf8");
  expect(old).toContain('<meta http-equiv="refresh" content="0; url=/kit/docs/static/"><link rel="canonical" href="/kit/docs/static/">');
  expect(old).toContain('This page is now at <a href="/kit/docs/static/">/kit/docs/static/</a>.');
  expect(old).not.toContain("<script");
  expect(await readFile(join(result.outDir, "a/b/index.html"), "utf8")).toContain('url=https://example.com/b/');
  expect(await readFile(join(result.outDir, "account/index.html"), "utf8")).toContain('url=/kit/docs/static/');
  const manifest = await readManifest(result.outDir);
  expect(manifest.routes).toEqual(["/kit/", "/kit/docs/static/"]);
  expect(result.routes).toEqual(manifest.routes);
  expect(manifest.redirects).toEqual([{ from: "/kit/old/", to: "/kit/docs/static/", status: 308 },
    { from: "/kit/a/b/", to: "https://example.com/b/", status: 308 }, { from: "/kit/account/", to: "/kit/docs/static/", status: 307 }]);
  // A redirect from a page's own URL would leave the page unreachable.
  await expect(buildApplication({ root, redirects: { "/docs/static/": "/" } })).rejects.toThrow(/also redirects \/docs\/static\/, which is this page's URL/);
}, 60_000);

it("refuses a symbolic-link page or page folder, naming it, as it refuses symbolic-link public assets", async () => {
  const root = await site({});
  await write(root, "other/page.html", '<template component="page-other"><h1>Other</h1></template>');
  await write(root, "other/data.json", "{}");
  // Files beside the pages that aren't pages, such as data a loader reads, may be links.
  await symlink(join(root, "other/data.json"), join(root, "app/pages/data.json"));
  await symlink(join(root, "other/page.html"), join(root, "app/pages/_shared.html"));
  expect((await discoverRoutes(root)).map(route => route.pattern)).toEqual(["/"]);
  await symlink(join(root, "other/page.html"), join(root, "app/pages/page.html"));
  await expect(discoverRoutes(root)).rejects.toThrow(`${join(root, "app/pages/page.html")}: Pages and page folders must not be symbolic links`);
  await rm(join(root, "app/pages/page.html"));
  await symlink(join(root, "other"), join(root, "app/pages/linked"));
  await expect(discoverRoutes(root)).rejects.toThrow(`${join(root, "app/pages/linked")}: Pages and page folders must not be symbolic links`);
  await rm(join(root, "app/pages/linked"));
  await symlink(join(root, "other"), join(root, "public"));
  await expect(buildApplication({ root })).rejects.toThrow("Public assets must not be symbolic links");
});
