import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { HtmlDiagnosticError } from "../src/diagnostics.js";
import type { FetchedComponent } from "../src/graph.js";
import { buildComponentGraph, parseComponentResource } from "../src/source-graph.js";
import { ResourceResolver } from "../src/resolve.js";
import { listedSourceRoot, matchesSourceList } from "../src/source-list.js";

const root = "https://cdn.example/ui/1/";
const resolver = () => new ResourceResolver({ imports: { "@ui/": root } }, "https://app.example/");

function component(tag: string, dependencies = "", controller = ""): string {
  return `${dependencies}<template component="${tag}" status="early" summary="${tag}."${
    controller === "" ? "" : ` controller="${controller}"`
  }><div></div></template>`;
}

function fetcher(files: Readonly<Record<string, string | FetchedComponent>>) {
  const counts = new Map<string, number>();
  return {
    counts,
    fetchComponent: async (url: string): Promise<FetchedComponent> => {
      counts.set(url, (counts.get(url) ?? 0) + 1);
      const value = files[url];
      if (value === undefined) throw new TypeError(`Missing fixture ${url}`);
      return typeof value === "string" ? { url, source: value } : value;
    },
  };
}

async function expectDiagnostic(code: string, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(
    run,
    (error: unknown) => error instanceof HtmlDiagnosticError && error.diagnostic.code === code,
  );
}

describe("component graph", () => {
  it("ignores build metadata with or without head wrappers while retaining component edges", async () => {
    const metadata = '<meta name="hk:layout" content="admin"><meta name="app:page" content="x-app">';
    for (const prefix of [metadata, `<head>${metadata}</head>`]) {
      const fixtures = fetcher({
        [`${root}app.html`]: prefix + component("x-app", '<link rel="component" href="./child.html">'),
        [`${root}child.html`]: component("x-child"),
      });
      const graph = await buildComponentGraph(["@ui/app.html"], {
        resolver: resolver(), fetchComponent: fixtures.fetchComponent,
      });
      assert.deepEqual([...graph.tags.keys()].sort(), ["x-app", "x-child"]);
      assert.deepEqual([...fixtures.counts.keys()].sort(), [`${root}app.html`, `${root}child.html`]);
      const parsed = parseComponentResource(prefix + component("x-app"), "page.html");
      assert.equal(parsed.definitions.length, 1);
      assert.deepEqual(parsed.dependencies, []);
      assert.deepEqual(parsed.definition.contract, parseComponentResource(component("x-app"), "page.html").definition.contract);
    }
  });

  it("rejects head content at resource scope, where it would belong to no component", () => {
    for (const content of ['<title>Imported title</title>', '<meta name="description" content="Imported description">',
      '<meta property="og:title" content="Imported social title">', '<link rel="stylesheet" href="./ignored.css">',
      '<link rel="canonical" href="https://other.example/">', '<meta name="app:page" content="x-app" onclick="run()">',
      '<script type="application/ld+json">{}</script>', '<style>p { color: red; }</style>']) {
      assert.throws(() => parseComponentResource(content + component("x-app"), "page.html"),
        (error: unknown) => error instanceof HtmlDiagnosticError && error.diagnostic.code === "HT009", content);
    }
  });

  it("retains the singular parser result as an alias for the first definition", () => {
    const parsed = parseComponentResource(component("ui-button") + component("ui-dialog"), "library.html");
    assert.equal(parsed.definition, parsed.definitions[0]);
    assert.deepEqual(parsed.definitions.map((definition) => definition.contract.tag), ["ui-button", "ui-dialog"]);
  });

  it("loads every named component in a resource once and connects sibling definitions", async () => {
    const library = `${root}library.html`;
    const fixtures = fetcher({
      [library]: component("ui-button", `<link rel="component" href="./shared.html">`, "./button.js") +
        component("ui-dialog", "", "./dialog.js"),
      [`${root}shared.html`]: component("ui-icon", `<link rel="component" href="./library.html">`),
    });
    const graph = await buildComponentGraph(["@ui/library.html", "@ui/shared.html"], {
      resolver: resolver(), fetchComponent: fixtures.fetchComponent,
    });
    assert.deepEqual([...graph.nodes.values()].map((node) => node.definition.contract.name).sort(), ["UiButton", "UiDialog", "UiIcon"]);
    assert.equal(fixtures.counts.get(library), 1);
    const button = graph.nodes.get(graph.tags.get("ui-button")!)!;
    const dialog = graph.nodes.get(graph.tags.get("ui-dialog")!)!;
    assert.notEqual(button.id, dialog.id);
    assert.equal(button.url, library);
    assert.equal(dialog.url, library);
    assert.equal(button.controller?.url, `${root}button.js`);
    assert.equal(dialog.controller?.url, `${root}dialog.js`);
    assert.ok(button.dependencies.includes(graph.tags.get("ui-icon")!));
    assert.ok(graph.roots.includes(button.id));
    assert.ok(graph.roots.includes(dialog.id));
  });

  it("rejects duplicate component names within the same resource", async () => {
    await expectDiagnostic("HL007", () => buildComponentGraph(["@ui/library.html"], {
      resolver: resolver(),
      fetchComponent: fetcher({ [`${root}library.html`]: component("ui-button") + component("ui-button") }).fetchComponent,
    }));
  });

  it("loads a mapped transitive graph, deduplicates a diamond, and records controller entries", async () => {
    const shared = `${root}shared.html`;
    const fixtures = fetcher({
      [`${root}app.html`]: component(
        "x-app",
        `<link rel="component" href="./left.html"><link rel="component" href="./right.html">`,
        "./app.js",
      ),
      [`${root}left.html`]: component("x-left", `<link rel="component" href="./shared.html">`),
      [`${root}right.html`]: component("x-right", `<link rel="component" href="./shared.html">`),
      [shared]: component("x-shared"),
    });
    const graph = await buildComponentGraph(["@ui/app.html"], {
      resolver: resolver(),
      fetchComponent: fixtures.fetchComponent,
    });

    assert.equal(graph.nodes.size, 4);
    assert.equal(fixtures.counts.get(shared), 1);
    assert.deepEqual(graph.roots, [`${root}app.html`]);
    assert.equal(graph.nodes.get(`${root}app.html`)?.controller?.url, `${root}app.js`);
    assert.deepEqual(graph.nodes.get(`${root}app.html`)?.dependencies, [
      `${root}left.html`,
      `${root}right.html`,
    ]);
  });

  it("terminates cycles and marks definitions shadowed by registered custom elements", async () => {
    const fixtures = fetcher({
      [`${root}a.html`]: component("x-a", `<link rel="component" href="./b.html">`),
      [`${root}b.html`]: component("x-b", `<link rel="component" href="./a.html">`),
    });
    const graph = await buildComponentGraph(["@ui/a.html"], {
      resolver: resolver(),
      fetchComponent: fixtures.fetchComponent,
      isCustomElementRegistered: (tag) => tag === "x-b",
    });
    assert.equal(graph.nodes.size, 2);
    assert.deepEqual(graph.nodes.get(`${root}b.html`)?.dependencies, [`${root}a.html`]);
    assert.equal(graph.nodes.get(`${root}b.html`)?.shadowedByCustomElement, true);
  });

  it("loads same-origin roots and rejects unapproved live-scope escapes", async () => {
    const sameOrigin = await buildComponentGraph(["/components/app.html"], {
      resolver: new ResourceResolver({}, "https://app.example/page"),
      fetchComponent: fetcher({
        ["https://app.example/components/app.html"]: component(
          "x-app",
          `<link rel="component" href="/shared.html">`,
          "/app.js",
        ),
        ["https://app.example/shared.html"]: component("x-shared"),
      }).fetchComponent,
    });
    assert.deepEqual(sameOrigin.roots, ["https://app.example/components/app.html"]);
    assert.deepEqual(sameOrigin.nodes.get("https://app.example/components/app.html")?.dependencies, [
      "https://app.example/shared.html",
    ]);
    assert.equal(
      sameOrigin.nodes.get("https://app.example/components/app.html")?.controller?.url,
      "https://app.example/app.js",
    );

    const directCrossOrigin = fetcher({});
    await expectDiagnostic("HL010", () => buildComponentGraph([
      "https://cdn.example/ui/1/app.html",
    ], {
      resolver: new ResourceResolver({}, "https://app.example/"),
      fetchComponent: directCrossOrigin.fetchComponent,
    }));
    assert.equal(directCrossOrigin.counts.size, 0);

    await expectDiagnostic("HL010", () => buildComponentGraph(["./app.html"], {
      resolver: new ResourceResolver(
        {},
        "https://cdn.example/ui/1/",
        "https://app.example/page",
      ),
      fetchComponent: directCrossOrigin.fetchComponent,
    }));
    assert.equal(directCrossOrigin.counts.size, 0);

    await expectDiagnostic("HL003", () => buildComponentGraph(["@ui/../escape.html"], {
      resolver: resolver(),
      fetchComponent: directCrossOrigin.fetchComponent,
    }));
    assert.equal(directCrossOrigin.counts.size, 0);

    await expectDiagnostic("HL003", () => buildComponentGraph(["@ui/app.html"], {
      resolver: resolver(),
      fetchComponent: fetcher({
        [`${root}app.html`]: component("x-app", `<link rel="component" href="../escape.html">`),
      }).fetchComponent,
    }));

    await expectDiagnostic("HL004", () => buildComponentGraph(["@ui/app.html"], {
      resolver: resolver(),
      fetchComponent: fetcher({
        [`${root}app.html`]: {
          url: "https://evil.example/app.html",
          source: component("x-app"),
        },
      }).fetchComponent,
    }));

    await expectDiagnostic("HL005", () => buildComponentGraph(["@ui/app.html"], {
      resolver: resolver(),
      fetchComponent: fetcher({
        [`${root}app.html`]: component("x-app", "", "https://evil.example/app.js"),
      }).fetchComponent,
    }));
  });

  it("rejects tag collisions and unsupported, active, or policy-changing resource markup", async () => {
    await expectDiagnostic("HL007", () => buildComponentGraph(["@ui/a.html", "@ui/b.html"], {
      resolver: resolver(),
      fetchComponent: fetcher({
        [`${root}a.html`]: component("x-same"),
        [`${root}b.html`]: component("x-same"),
      }).fetchComponent,
    }));

    for (const active of [
      `<script type="importmap">{}</script>`,
      `<script>bad()</script>`,
      `<script type="application/ld+json">{}</script>`,
      `<style>body { display: none }</style>`,
      `<div>Unrelated body content</div>`,
      `<template><div>Unrelated template</div></template>`,
      `Unrelated text`,
      `<base href="https://evil.example/">`,
      `<meta http-equiv="content-security-policy" content="default-src *">`,
      `<meta http-equiv="refresh" content="0;url=https://evil.example/">`,
      `<meta name="description" content="Ignored" onclick="bad()">`,
      `<link rel="import" href="https://evil.example/import.html">`,
      `<link rel="stylesheet" href="./ignored.css" onload="bad()">`,
    ]) {
      await expectDiagnostic("HT009", () => buildComponentGraph(["@ui/app.html"], {
        resolver: resolver(),
        fetchComponent: fetcher({ [`${root}app.html`]: active + component("x-app") }).fetchComponent,
      }));
    }
    await expectDiagnostic("HT010", () => buildComponentGraph(["@ui/app.html"], {
      resolver: resolver(),
      fetchComponent: fetcher({
        [`${root}app.html`]: component("x-app").replace("<div>", `<div onclick="bad()">`),
      }).fetchComponent,
    }));
  });
});

describe("imported components and document authority", () => {
  // Document-authority entries, and one ordinary head declaration each component keeps.
  const head = (tag: string, dependencies = ""): string => `${dependencies}<template component="${tag}"><defs>
    <title>${tag}</title><link rel="canonical" href="https://${tag}.example/"><link rel="alternate" hreflang="fr" href="/fr/">
    <link rel="icon" href="/${tag}.png"><link rel="manifest" href="/app.webmanifest">
    <meta name="robots" content="noindex"><meta name="Referrer" content="no-referrer"><meta name="viewport" content="width=1">
    <meta name="color-scheme" content="dark"><meta name="theme-color" content="red"><meta property="og:url" content="https://${tag}.example/">
    <link rel="preconnect" href="https://${tag}.example"></defs><div></div></template>`;
  const kept = (definition: { head?: readonly { kind: string }[] }): string[] => (definition.head ?? []).map((declaration) => declaration.kind);

  it("leaves out an imported component's document-authority entries, with a warning, and keeps the rest", async () => {
    const warnings: string[] = [];
    const graph = await buildComponentGraph(["./app.html", "@ui/widget.html"], {
      resolver: resolver(),
      warn: (diagnostic) => warnings.push(`${diagnostic.code} ${diagnostic.message}`),
      fetchComponent: fetcher({
        "https://app.example/app.html": head("x-app"),
        // A relative edge from an imported component is imported too.
        [`${root}widget.html`]: head("x-widget", '<link rel="component" href="./part.html">'),
        [`${root}part.html`]: head("x-part"),
      }).fetchComponent,
    });
    const node = (tag: string) => graph.nodes.get(graph.tags.get(tag)!)!;
    assert.equal(node("x-app").imported, undefined);
    assert.equal(kept(node("x-app").definition).length, 12);
    for (const tag of ["x-widget", "x-part"]) {
      assert.equal(node(tag).imported, true);
      assert.deepEqual(kept(node(tag).definition), ["title", "link"]);
    }
    assert.equal(warnings.length, 20);
    assert.match(warnings[0]!, /^HL011 <x-part> is an imported component, so its <link rel="canonical"> is ignored/);
    assert.ok(warnings.some((warning) => warning.includes('<meta name="referrer">')));
  });

  it("treats a resource reached both ways as imported, and an unlisted source as imported", async () => {
    const both = await buildComponentGraph(["./app.html"], {
      resolver: new ResourceResolver({ imports: { "@app/": "https://app.example/" } }, "https://app.example/"),
      warn: () => {},
      fetchComponent: fetcher({
        "https://app.example/app.html": head("x-app", '<link rel="component" href="./shared.html"><link rel="component" href="@app/shared.html">'),
        "https://app.example/shared.html": head("x-shared"),
      }).fetchComponent,
    });
    assert.equal(both.nodes.get("https://app.example/app.html")!.imported, undefined);
    assert.equal(both.nodes.get("https://app.example/shared.html")!.imported, true);
    const unlisted = await buildComponentGraph(["./app.html"], {
      resolver: resolver(), warn: () => {}, isApplicationURL: (url) => !url.endsWith("/app.html"),
      fetchComponent: fetcher({ "https://app.example/app.html": head("x-app") }).fetchComponent,
    });
    assert.equal(unlisted.nodes.get("https://app.example/app.html")!.imported, true);
  });
});

describe("application-components source list", () => {
  const document = "https://acme.example/app/";
  it("matches URLs by CSP source expressions, with 'self' always included", () => {
    const cases: readonly (readonly [string, string, boolean])[] = [
      ["https://acme.example/ui/x.html", "", true],
      ["http://acme.example/ui/x.html", "", false],
      ["https://cdn.acme.example/ui/x.html", "", false],
      ["https://cdn.acme.example/ui/x.html", "'self' https://cdn.acme.example/ui/", true],
      ["https://cdn.acme.example/other/x.html", "https://cdn.acme.example/ui/", false],
      ["https://cdn.acme.example/ui/x.html", "https://cdn.acme.example/ui/x.html", true],
      ["https://cdn.acme.example/ui/y.html", "https://cdn.acme.example/ui/x.html", false],
      ["https://cdn.acme.example/ui/x.html", "cdn.acme.example", true],
      ["https://cdn.acme.example/ui/x.html", "*.acme.example", true],
      ["https://acme.example.evil/ui/x.html", "*.acme.example", false],
      ["https://cdn.acme.example:8443/x.html", "https://cdn.acme.example", false],
      ["https://cdn.acme.example:8443/x.html", "https://cdn.acme.example:*", true],
      ["https://cdn.acme.example:443/x.html", "https://cdn.acme.example:443", true],
      ["https://any.example/x.html", "https:", true],
      ["https://any.example/x.html", "*", true],
      ["https://cdn.acme.example/ui/x.html", "http://cdn.acme.example/ui/", true],
      ["https://cdn.acme.example/ui/x.html", "'none' 'unsafe-inline' 'nonce-abc'", false],
    ];
    for (const [url, sources, expected] of cases) assert.equal(matchesSourceList(url, sources, document), expected, `${url} in ${sources}`);
  });

  it("names the prefix a listed source approves for a cross-origin root", () => {
    assert.equal(listedSourceRoot("https://cdn.acme.example/ui/a/x.html", "https://cdn.acme.example/ui/", document), "https://cdn.acme.example/ui/");
    assert.equal(listedSourceRoot("https://cdn.acme.example/ui/x.html", "https://cdn.acme.example", document), "https://cdn.acme.example/");
    assert.equal(listedSourceRoot("https://cdn.acme.example/ui/x.html", "https://cdn.acme.example/ui/x.html", document), "https://cdn.acme.example/ui/");
    assert.equal(listedSourceRoot("https://cdn.acme.example/ui/x.html", "", document), undefined);
  });

  it("lets the application-owned list approve a cross-origin live root, whose edges stay inside its prefix", async () => {
    const listed = new ResourceResolver({}, document, document, (url) => listedSourceRoot(url, "https://cdn.acme.example/ui/", document));
    const graph = await buildComponentGraph(["https://cdn.acme.example/ui/app.html"], {
      resolver: listed, fetchComponent: fetcher({
        "https://cdn.acme.example/ui/app.html": component("x-app", '<link rel="component" href="./child.html">'),
        "https://cdn.acme.example/ui/child.html": component("x-child"),
      }).fetchComponent,
    });
    assert.deepEqual([...graph.tags.keys()], ["x-app", "x-child"]);
    await expectDiagnostic("HL003", () => buildComponentGraph(["https://cdn.acme.example/ui/escape.html"], {
      resolver: listed, fetchComponent: fetcher({ "https://cdn.acme.example/ui/escape.html": component("x-escape", '<link rel="component" href="../other.html">') }).fetchComponent,
    }));
    await expectDiagnostic("HL010", () => buildComponentGraph(["https://cdn.acme.example/other/app.html"], {
      resolver: listed, fetchComponent: fetcher({}).fetchComponent,
    }));
  });
});
