import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApplication, createApplication, devApplication, type HtmlKitPlugin } from "../src/index.js";
import { checkLinks } from "../src/links.js";
import { write } from "./fixture.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** A site whose default layout has a loader, so every page renders through it. */
async function site(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "htmlkit-static-")); roots.push(root);
  await write(root, "package.json", '{"type":"module"}');
  await write(root, "app/layouts/default.html", `<template component="site-shell"><defs><prop name="brand" type="string" required>Brand</prop><title>Site</title></defs>
    <main><header>{$brand}</header><slot name="page"></slot></main></template>`);
  await write(root, "app/layouts/default.server.ts", `export const load = ({ url }) => {
    if (url.pathname.includes("layout-fails")) throw new Error("layout secret");
    return { props: { brand: "Kit" } };
  };`);
  await write(root, "app/pages/index.html", '<template component="home-page"><defs><title>Home</title></defs><h1>Home</h1></template>');
  return root;
}

describe("the error page", () => {
  async function failing(): Promise<string> {
    const root = await site();
    await write(root, "app/error.html", `<template component="error-page"><defs>
      <prop name="status" type="number" required>Status</prop><prop name="message" type="string" required>Reason</prop><title>Trouble</title></defs>
      <section><h1>{$status}</h1><p>{$message}</p></section></template>`);
    await write(root, "app/pages/broken.html", '<template component="broken-page"><h1>Broken</h1></template>');
    await write(root, "app/pages/broken.server.ts", 'export const load = () => { throw new Error("database secret"); };');
    await write(root, "app/pages/layout-fails.html", '<template component="layout-fails-page"><h1>Unreached</h1></template>');
    return root;
  }

  it("answers application.fetch failures with app/error.html, its status, and a safe message", async () => {
    const root = await failing();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const application = await createApplication({ root });
    try {
      // The error page is no route: no URL serves it and navigation leaves it out.
      expect(application.error?.pageName).toBe("error-page");
      expect(application.routes.some(route => route.pageName === "error-page")).toBe(false);
      expect((await application.navigation()).map(item => item.pageName)).not.toContain("error-page");
      expect((await application.fetch(new Request("http://localhost/error/"))).status).toBe(404);
      // render() reports the failure, which is how a build fails.
      await expect(application.render("/broken/")).rejects.toThrow("database secret");
      const response = await application.fetch(new Request("http://localhost/broken/"));
      expect(response.status).toBe(500);
      const html = await response.text();
      expect(html).toContain(">Trouble</title>");
      expect(html).toContain('data-component="site-shell"');
      expect(html).toContain("<h1>500</h1><p>Internal Server Error</p>");
      expect(html).not.toContain("secret");
      expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: "database secret" }));
      // A failed page has no payload; client navigation then loads its document.
      expect((await application.fetch(new Request("http://localhost/_htmlkit/pages/broken/payload.json"))).status).toBe(500);
      // When the layout fails, the error page shares its fate, and the built-in page answers.
      const layout = await application.fetch(new Request("http://localhost/layout-fails/"));
      expect(layout.status).toBe(500);
      const plain = await layout.text();
      expect(plain).toContain(">Internal Server Error</title>");
      expect(plain).not.toContain("secret");
    } finally { await application.close(); }
  });

  it("answers with a built-in page without app/error.html, and fails the build", async () => {
    const root = await site();
    await write(root, "app/pages/broken.html", '<template component="broken-page"><h1>Broken</h1></template>');
    await write(root, "app/pages/broken.server.ts", 'export const load = () => { throw new Error("database secret"); };');
    vi.spyOn(console, "error").mockImplementation(() => {});
    const application = await createApplication({ root });
    try {
      const response = await application.fetch(new Request("http://localhost/broken/"));
      expect([response.status, await response.text()]).toEqual([500, expect.stringContaining("<main><h1>Internal Server Error</h1></main>")]);
    } finally { await application.close(); }
    await expect(buildApplication({ root })).rejects.toThrow("database secret");
    expect(existsSync(join(root, "dist"))).toBe(false);
  });

  it("is not part of a static build, and development shows the error itself", async () => {
    const root = await failing();
    await rm(join(root, "app/pages/broken.server.ts"));
    await rm(join(root, "app/pages/layout-fails.html"));
    const result = await buildApplication({ root });
    expect(result.routes).toEqual(["/", "/broken/"]);
    const files = await readdir(result.outDir, { recursive: true });
    expect(files.some(file => file.includes("error") || file.includes("500"))).toBe(false);
    await write(root, "app/pages/broken.server.ts", 'export const load = () => { throw new Error("database secret"); };');
    const server = await devApplication({ root, port: 0 });
    try {
      const response = await fetch(server.url + "broken/");
      expect(response.status).toBe(500);
      expect(await response.text()).toContain("database secret");
    } finally { await server.close(); }
  }, 60_000);

  it("takes no loader", async () => {
    const root = await failing();
    await write(root, "app/error.server.ts", "export const load = () => ({});");
    await expect(createApplication({ root })).rejects.toThrow("app/error.html has no loader");
  });
});

describe("sitemap.xml and robots.txt", () => {
  async function pages(): Promise<string> {
    const root = await site();
    await write(root, "app/pages/about.html", '<template component="about-page"><defs><title>About</title><meta name="hk:alias" content="/old-about/"></defs><h1>About</h1></template>');
    await write(root, "app/pages/hidden.html", '<template component="hidden-page"><defs><title>Hidden</title><meta name="hk:navigation" content="hidden"></defs><h1>Hidden</h1></template>');
    await write(root, "app/pages/private.html", '<template component="private-page"><defs><title>Private</title><meta name="robots" content="noindex, follow"></defs><h1>Private</h1></template>');
    await write(root, "app/pages/posts/[slug].html", '<template component="post-page"><defs><title>Post</title><meta name="hk:alias" content="/articles/[slug]/"></defs><h1>Post</h1></template>');
    await write(root, "app/pages/posts/[slug].server.ts", "export const entries = () => [{ slug: 'a&b' }];");
    await write(root, "app/pages/404.html", '<template component="missing-page"><defs><title>Lost</title></defs><h1>Lost</h1></template>');
    return root;
  }

  it("lists each page at its own URL when origin is set, and alias pages name it canonical", async () => {
    const root = await pages();
    const result = await buildApplication({ root, base: "/docs/", origin: "https://example.com", redirects: { "/start/": "/about/" }, robots: true });
    // Hidden pages are only out of navigation; aliases, redirects, the 404 page, and noindex pages are left out.
    expect(await readFile(join(result.outDir, "sitemap.xml"), "utf8")).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://example.com/docs/</loc></url>
<url><loc>https://example.com/docs/about/</loc></url>
<url><loc>https://example.com/docs/hidden/</loc></url>
<url><loc>https://example.com/docs/posts/a%26b/</loc></url>
</urlset>
`);
    expect(await readFile(join(result.outDir, "old-about/index.html"), "utf8")).toContain('<link rel="canonical" href="https://example.com/docs/about/">');
    expect(await readFile(join(result.outDir, "articles/a&b/index.html"), "utf8")).toContain('<link rel="canonical" href="https://example.com/docs/posts/a%26b/">');
    expect(await readFile(join(result.outDir, "about/index.html"), "utf8")).not.toContain("canonical");
    expect(await readFile(join(result.outDir, "robots.txt"), "utf8")).toBe("User-agent: *\nAllow: /\nSitemap: https://example.com/docs/sitemap.xml\n");
  }, 60_000);

  it("serves an alias page directory with canonical links to its own prefix, and lists only that one", async () => {
    const root = await site();
    await write(root, "docs/index.html", '<template component="docs-home"><defs><title>Docs</title></defs><h1>Docs</h1></template>');
    await write(root, "docs/guide.html", '<template component="docs-guide"><defs><title>Guide</title><meta name="hk:alias" content="/start/"></defs><h1>Guide</h1></template>');
    await write(root, "docs/posts/[slug].html", '<template component="docs-post"><defs><title>Post</title></defs><h1>Post</h1></template>');
    await write(root, "docs/posts/[slug].server.ts", "export const entries = () => [{ slug: 'a&b' }];");
    const pages = [{ dir: "docs", prefix: "/v/current/", alias: true }, { dir: "docs", prefix: "/docs/" }];
    const result = await buildApplication({ root, origin: "https://example.com", fileRoutes: true, pages });
    expect(await readFile(join(result.outDir, "sitemap.xml"), "utf8")).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://example.com/docs/</loc></url>
<url><loc>https://example.com/docs/guide/</loc></url>
<url><loc>https://example.com/docs/posts/a%26b/</loc></url>
</urlset>
`);
    const canonical = async (path: string) => [...(await readFile(join(result.outDir, path, "index.html"), "utf8")).matchAll(/<link rel="canonical" href="([^"]*)"/g)].map(match => match[1]);
    expect(await canonical("v/current")).toEqual(["https://example.com/docs/"]);
    expect(await canonical("v/current/guide")).toEqual(["https://example.com/docs/guide/"]);
    expect(await canonical("v/current/posts/a&b")).toEqual(["https://example.com/docs/posts/a%26b/"]);
    expect(await canonical("v/current/start")).toEqual(["https://example.com/docs/guide/"]);
    expect(await canonical("docs/guide")).toEqual([]);
    // Still a site of its own to navigate.
    const application = await createApplication({ root, pages });
    try {
      expect((await application.navigation({ from: "/v/current/" })).map(item => item.href)).toEqual(["/v/current/", "/v/current/guide/", "/v/current/posts/a%26b/"]);
    } finally { await application.close(); }
    // Two own prefixes for one directory would list each page twice.
    await expect(buildApplication({ root, pages: [{ dir: "docs", prefix: "/v/current/" }, { dir: "docs", prefix: "/docs/" }] }))
      .rejects.toThrow("Page directory docs is served at /v/current/ and /docs/; mark the further one alias: true");
    await expect(buildApplication({ root, pages: [{ dir: "docs", prefix: "/v/current/", alias: true }] })).rejects.toThrow("needs an entry that serves docs itself");
  }, 60_000);

  it("keeps a public sitemap, writes robots.txt from its text, and gives aliases a path canonical without origin", async () => {
    const root = await site();
    await write(root, "app/pages/about.html", '<template component="about-page"><defs><title>About</title><meta name="hk:alias" content="/old-about/"></defs><h1>About</h1></template>');
    // An alias's own canonical link stays.
    await write(root, "app/pages/hidden.html", '<template component="hidden-page"><defs><title>Hidden</title><link rel="canonical" href="https://elsewhere.example/"><meta name="hk:alias" content="/also-hidden/"></defs><h1>Hidden</h1></template>');
    const application = await createApplication({ root });
    try {
      const canonical = async (path: string) => [...(await application.render(path)).head.html.matchAll(/<link rel="canonical" href="([^"]*)"/g)].map(match => match[1]);
      expect(await canonical("/old-about/")).toEqual(["/about/"]);
      expect(await canonical("/also-hidden/")).toEqual(["https://elsewhere.example/"]);
    } finally { await application.close(); }
    await write(root, "public/sitemap.xml", "<urlset>own</urlset>");
    const result = await buildApplication({ root, origin: "https://example.com", robots: "User-agent: *\nSitemap: https://example.com/maps.xml\n" });
    expect(await readFile(join(result.outDir, "sitemap.xml"), "utf8")).toBe("<urlset>own</urlset>");
    expect(await readFile(join(result.outDir, "robots.txt"), "utf8")).toBe("User-agent: *\nSitemap: https://example.com/maps.xml\n");
    // Both fail before any page renders.
    await write(root, "public/robots.txt", "User-agent: *\n");
    await expect(buildApplication({ root, robots: true })).rejects.toThrow("robots.txt is generated");
    await expect(buildApplication({ root, robots: 1 as unknown as boolean })).rejects.toThrow("robots must be");
  }, 60_000);
});

describe("the internal link check", () => {
  async function linked(): Promise<string> {
    const root = await site();
    await write(root, "app/pages/index.html", `<template component="home-page"><defs><title>Home</title></defs><article>
      <a href="/docs/guide/">Guide</a> <a href="guide/#install">Install</a> <a href="/docs/guide/#named">Named</a> <a href="#top">Top</a> <a href="#">Empty</a>
      <a href="/docs/guide/#:~:text=Install">Text fragment</a> <a href="/docs/file.pdf">File</a> <a href="/docs/start/">Redirected</a> <a href="/docs/guide">No slash</a>
      <a href="/docs/search.json">Plugin file</a> <a href="/elsewhere/">Outside base</a> <a href="https://example.com/x/">External</a> <a href="mailto:a@example.com">Mail</a>
      <a href="/docs/?q=1#home">Query</a> <h1 id="home">Home</h1></article></template>`);
    await write(root, "app/pages/guide.html", '<template component="guide-page"><defs><title>Guide</title></defs><article><h2 id="install">Install</h2><a name="named">Named</a></article></template>');
    await write(root, "public/file.pdf", "%PDF");
    return root;
  }
  const search: HtmlKitPlugin = { name: "search", buildEnd: ({ writeFile }) => writeFile("search.json", "[]") };

  it("passes links to pages, files, redirects, and anchors in the build", async () => {
    const root = await linked();
    const result = await buildApplication({ root, base: "/docs/", redirects: { "/start/": "/guide/" }, plugins: [search], robots: "User-agent: *\nDisallow: /private/" });
    expect(result.routes).toEqual(["/docs/", "/docs/guide/"]);
    // Without origin, the build writes no sitemap.xml, and robots.txt is the option's text.
    expect(existsSync(join(result.outDir, "sitemap.xml"))).toBe(false);
    expect(await readFile(join(result.outDir, "robots.txt"), "utf8")).toBe("User-agent: *\nDisallow: /private/\n");
  }, 60_000);

  it("fails on a missing page, file, or anchor, naming the page and the link, or warns", async () => {
    const root = await linked();
    await write(root, "app/pages/guide.html", `<template component="guide-page"><defs><title>Guide</title></defs><article><h2 id="install">Install</h2><a name="named">Named</a>
      <a href="/docs/missing/">Missing</a> <a href="#nowhere">Nowhere</a> <a href="/docs/#gone">Gone</a> <a href="../file.txt">File</a></article></template>`);
    const broken = [
      "Broken internal links:",
      "  /docs/guide/ links to /docs/missing/, which is no page or file in the build.",
      '  /docs/guide/ links to #nowhere, and /docs/guide/ has no element with id "nowhere".',
      '  /docs/guide/ links to /docs/#gone, and /docs/ has no element with id "gone".',
      "  /docs/guide/ links to ../file.txt, which is no page or file in the build.",
      "  /docs/start/ links to /docs/missing-too/, which is no page or file in the build.",
    ].join("\n");
    // One build: "warn" reports the links and finishes; the check then fails on the same built HTML.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await buildApplication({ root, base: "/docs/", redirects: { "/start/": "/missing-too/" }, plugins: [search], linkCheck: "warn" });
    expect(warned).toHaveBeenCalledWith(broken);
    expect(await readFile(join(result.outDir, "guide/index.html"), "utf8")).toContain("Missing");
    await expect(checkLinks(result.outDir, "http://localhost", "/docs/", ["/docs/", "/docs/guide/", "/docs/start/", "/docs/404.html"])).rejects.toThrow(broken);
    await expect(buildApplication({ root, linkCheck: "off" as "warn" })).rejects.toThrow('linkCheck must be "error" or "warn".');
  }, 60_000);
});
