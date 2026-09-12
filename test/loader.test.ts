import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadNodeComponents } from "../src/node-loader.js";
import { ComponentRegistry } from "../src/registry.js";

describe("package loader and registry", () => {
  it("resolves a package subpath, walks HTML edges, and records ESM inputs without execution", async () => {
    const files: Record<string, string> = {
      "file:///pkg/components/app.html":
        `<link rel="component" href="../shared/button.html">` +
        `<template component="x-app" status="early" summary="App." controller="./app.js"><x-button></x-button></template>`,
      "file:///pkg/shared/button.html":
        `<template component="x-button" status="early" summary="Button."><button></button></template>`,
    };
    let executed = false;
    const graph = await loadNodeComponents(["@acme/ui/app"], {
      baseURL: "file:///workspace/",
      resolvePackage: (specifier) => {
        assert.equal(specifier, "@acme/ui/app");
        return { url: "file:///pkg/components/app.html", trustRoot: "file:///pkg/" };
      },
      readComponent: async (url) => ({ url, source: files[url]! }),
      inspectModule: async (url) => {
        executed = false;
        return url.endsWith("app.js")
          ? { url, dependencies: ["file:///pkg/shared/helper.js"] }
          : { url, dependencies: [] };
      },
    });

    assert.equal(graph.nodes.size, 2);
    assert.deepEqual(graph.moduleInputs, [
      "file:///pkg/components/app.js",
      "file:///pkg/shared/helper.js",
    ]);
    assert.equal(executed, false);
  });

  it("registers validated entries lazily and skips custom-element-owned tags", async () => {
    const graph = await loadNodeComponents(["file:///pkg/a.html"], {
      baseURL: "file:///pkg/index.html",
      readComponent: async (url) => ({
        url,
        source: `<template component="x-a" status="early" summary="A."><div></div></template>`,
      }),
    });
    const registry = new ComponentRegistry();
    const waiting = registry.whenDefined("x-a");
    registry.addGraph(graph);
    await waiting;
    assert.equal(registry.get("x-a")?.node.definition.contract.tag, "x-a");
  });
});
