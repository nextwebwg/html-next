import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clearControllerCache, loadController } from "../src/controller.js";
import { HtmlDiagnosticError } from "../src/diagnostics.js";
import { buildComponentGraph } from "../src/graph.js";
import { ResourceResolver } from "../src/resolve.js";

async function controllerNode() {
  const root = "https://cdn.example/ui/";
  const graph = await buildComponentGraph(["@ui/x.html"], {
    resolver: new ResourceResolver({ imports: { "@ui/": root } }, "https://app.example/"),
    fetchComponent: async (url) => ({
      url,
      source: `<template component="x-one" status="early" summary="One." controller="./x.js"><div></div></template>`,
    }),
  });
  return graph.nodes.get(`${root}x.html`)!;
}

describe("controller loading", () => {
  it("loads a callable default export once and invokes it per instance", async () => {
    clearControllerCache();
    const node = await controllerNode();
    let imports = 0;
    let calls = 0;
    const importer = async () => {
      imports += 1;
      return { default: () => { calls += 1; } };
    };
    const first = await loadController(node, importer);
    const second = await loadController(node, importer);
    first({});
    second({});
    assert.equal(imports, 1);
    assert.equal(calls, 2);
  });

  it("reports stable diagnostics for failed and invalid modules", async () => {
    clearControllerCache();
    const node = await controllerNode();
    await assert.rejects(
      () => loadController(node, async () => { throw new Error("offline"); }),
      (error: unknown) => error instanceof HtmlDiagnosticError && error.diagnostic.code === "HJ001",
    );
    clearControllerCache();
    await assert.rejects(
      () => loadController(node, async () => ({ default: 42 })),
      (error: unknown) => error instanceof HtmlDiagnosticError && error.diagnostic.code === "HJ002",
    );
  });
});
