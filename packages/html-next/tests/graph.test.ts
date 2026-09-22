import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { HtmlDiagnosticError } from "../src/diagnostics.js";
import type { FetchedComponent } from "../src/graph.js";
import { buildComponentGraph } from "../src/source-graph.js";
import { ResourceResolver } from "../src/resolve.js";

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

  it("leaves dependency, redirect, and controller authority to URL resolution and the platform", async () => {
    const escaped = await buildComponentGraph(["@ui/app.html"], {
      resolver: resolver(),
      fetchComponent: fetcher({
        [`${root}app.html`]: component("x-app", `<link rel="component" href="../escape.html">`),
        ["https://cdn.example/ui/escape.html"]: component("x-escape"),
      }).fetchComponent,
    });
    assert.deepEqual(escaped.nodes.get(`${root}app.html`)?.dependencies, [
      "https://cdn.example/ui/escape.html",
    ]);

    const redirected = await buildComponentGraph(["@ui/app.html"], {
      resolver: resolver(),
      fetchComponent: fetcher({
        [`${root}app.html`]: {
          url: "https://evil.example/app.html",
          source: component("x-app"),
        },
      }).fetchComponent,
    });
    assert.deepEqual(redirected.roots, ["https://evil.example/app.html"]);

    const controlled = await buildComponentGraph(["@ui/app.html"], {
      resolver: resolver(),
      fetchComponent: fetcher({
        [`${root}app.html`]: component("x-app", "", "https://evil.example/app.js"),
      }).fetchComponent,
    });
    assert.equal(
      controlled.nodes.get(`${root}app.html`)?.controller?.url,
      "https://evil.example/app.js",
    );
  });

  it("rejects tag collisions and active or policy-changing resource markup", async () => {
    await expectDiagnostic("HL007", () => buildComponentGraph(["@ui/a.html", "@ui/b.html"], {
      resolver: resolver(),
      fetchComponent: fetcher({
        [`${root}a.html`]: component("x-same"),
        [`${root}b.html`]: component("x-same"),
      }).fetchComponent,
    }));

    for (const active of [
      `<script type="importmap">{}</script>`,
      `<base href="https://evil.example/">`,
      `<meta http-equiv="content-security-policy" content="default-src *">`,
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
