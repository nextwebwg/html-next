import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { loadNodeComponents } from "../src/node-loader.js";
import { compileComponentStylesForBuild, compileComponentGraphStylesForBuild, compileSharedComponentStylesForBuild } from "../src/component-styles-build.js";
import { collectSharedStylesheets, wrapStylesheetConditions } from "../src/stylesheet-resources.js";
import { parseComponent } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";
import { parseStylesheetForBuild } from "../src/stylesheet-resources-build.js";

describe("shared component CSS resources", () => {
  it("reads CSS escapes and case-insensitive import functions, and ignores invalid empty functions", () => {
    const parsed = parseStylesheetForBuild('@import URL(shared\\ defaults.css) LAYER(base) SUPPORTS(display: grid); @import "missing.css" layer(); @import "other.css" supports();');
    assert.deepEqual(parsed.imports, [{ specifier: "shared defaults.css", conditions: { layer: "base", supports: "display: grid" } }]);
  });
  it("resolves nested CSS before scoping, keeps occurrences and asset bases, and caches source fetches", async () => {
    const files: Record<string, string> = {
      "file:///pkg/app.html": `<template component="x-a"><div></div><style>
        @import "./styles/defaults.css" layer(base);
        @import "./styles/defaults.css" layer;
        :host { box-sizing: content-box; }
      </style></template><template component="x-b"><section></section><style>@import "styles/defaults.css";</style></template>`,
      "file:///pkg/styles/defaults.css": `@import "nested/type.css" supports(display: grid) screen;
        :host, *, :host::before, *::after { box-sizing: border-box; }
        :slotted(p) { margin: 0; }
        .icon { background: url("./icons/check.svg"); content: "url(leave-me.svg)"; }
        .icon { filter: url("#local-filter"); }
        @media (width > 1px) { @keyframes pulse { to { opacity: 0.5; } } }
      `,
      "file:///pkg/styles/nested/type.css": `@import "../defaults.css";
        :host { font-family: Example; }
        @font-face { font-family: Example; src: url("./fonts/example.woff2"); }
      `,
    };
    const requests: string[] = [];
    const graph = await loadNodeComponents(["file:///pkg/app.html"], {
      readComponent: async (url) => { requests.push(url); return { url, source: files[url]! }; },
    });
    const definitions = [...graph.nodes.values()].map(node => node.definition);
    const a = definitions.find(definition => definition.contract.tag === "x-a")!;
    const b = definitions.find(definition => definition.contract.tag === "x-b")!;
    assert.doesNotMatch(a.css, /@import/);
    assert.doesNotMatch(a.css, /box-sizing: border-box/);
    assert.equal(a.stylesheets?.filter(sheet => sheet.url.endsWith("defaults.css")).length, 2);
    const compiled = collectSharedStylesheets([a]).map(shared => wrapStylesheetConditions(
      compileSharedComponentStylesForBuild(shared.stylesheet.css, shared.adopters).css, shared.stylesheet.conditions)).join("\n");
    assert.match(compiled, /file:\/\/\/pkg\/styles\/icons\/check.svg/);
    assert.match(compiled, /file:\/\/\/pkg\/styles\/nested\/fonts\/example.woff2/);
    assert.match(compiled, /"url\(leave-me.svg\)"/);
    assert.match(compiled, /url\("#local-filter"\)/);
    assert.match(compiled, /@scope \(\[data-component~="x-a"\]\)/);
    assert.match(compiled, /@supports/);
    assert.match(compiled, /@layer base/);
    assert.match(compiled, /@keyframes pulse/);
    assert.match(compiled, /@font-face/);
    assert.match(compileSharedComponentStylesForBuild(b.stylesheets!.at(-1)!.css, [b]).css, /data-component~="x-b"/);
    assert.deepEqual(requests.sort(), Object.keys(files).sort());
    assert.deepEqual(graph.stylesheetInputs, Object.keys(files).filter(file => file.endsWith(".css")).sort());
  });

  it("reports a missing stylesheet at its importing source rather than emitting a global import", async () => {
    await assert.rejects(loadNodeComponents(["file:///pkg/app.html"], {
      readComponent: async (url) => {
        if (url.endsWith(".css")) throw new Error("missing stylesheet");
        return { url, source: '<template component="x-a"><div></div><style>@import "missing.css";</style></template>' };
      },
    }), /HY004.*missing\.css.*app\.html|app\.html.*HY004.*missing\.css/s);
  });

  it("preserves conditional document-wide rules while scoping the group's style rules", () => {
    // Definitions are normalized by the real graph loader in the other cases.
    const definition = parseComponent('<template component="x-a"><div></div></template>');
    const css = compileComponentStylesForBuild(`@layer shared { @media (width > 1px) {
      @keyframes pulse { to { opacity: 0.5; } }
      :host { animation: pulse 1s; }
    } }`, definition).css;
    assert.match(css, /@keyframes pulse/);
    assert.match(css, /@layer shared/);
    assert.match(css, /@media \(width > 1px\)/);
    assert.match(css, /@scope/);
  });

  it("delivers one compatible body for two adopting definitions during SSR, with owner-specific state tests", async () => {
    const graph = await loadNodeComponents(["file:///pkg/app.html"], { readComponent: async url => ({ url, source:
      url.endsWith(".css") ? ':host-state([open]) { color: rebeccapurple; } * { box-sizing: border-box; }' :
      ["x-a", "x-b"].map(tag => `<template component="${tag}"><defs><state name="open" type="boolean" value="true"></state></defs><div><span>own</span></div><style>@import "defaults.css";</style></template>`).join("") }) });
    const definitions = [...graph.nodes.values()].map(node => node.definition);
    assert.equal(collectSharedStylesheets(definitions).length, 1);
    const rendered = await renderComponents('<x-a></x-a><x-b></x-b><x-a></x-a>', { definitions });
    assert.equal(rendered.css.match(/rebeccapurple/g)?.length, 1);
    assert.equal(rendered.css.match(/box-sizing: border-box/g)?.length, 1);
    assert.match(rendered.css, /data-x-a-state/);
    assert.match(rendered.css, /data-x-b-state/);
    assert.deepEqual(rendered.styleOwnership, { "x-a": ["open"], "x-b": ["open"] });
    assert.equal(rendered.css.trim(), compileComponentGraphStylesForBuild(definitions).trim());
  });

  it("diagnoses namespace imports instead of leaking their namespace environment into another component", async () => {
    await assert.rejects(loadNodeComponents(["file:///pkg/app.html"], { readComponent: async url => ({ url, source:
      url.endsWith(".css") ? '@namespace "http://www.w3.org/2000/svg"; rect { fill: red; }' :
      '<template component="x-a"><div></div><style>@import "defaults.css";</style></template>' }) }), /HY004.*@namespace/);
  });

  it("keeps scoped copies for incompatible conditions, opposite import orders, and intervening global overrides", () => {
    const a = parseComponent('<template component="x-a"><div></div></template>');
    const b = parseComponent('<template component="x-b"><div></div></template>');
    const x = { url: "file:///pkg/x.css", css: "p{color:red}", conditions: [] };
    const y = { url: "file:///pkg/y.css", css: "p{color:blue}", conditions: [] };
    const opposite = collectSharedStylesheets([{ ...a, stylesheets: [x, y] }, { ...b, stylesheets: [y, x] }]);
    assert.deepEqual(opposite.map(group => [group.stylesheet.url, group.adopters.map(owner => owner.contract.tag)]), [
      [x.url, ["x-a"]], [y.url, ["x-a", "x-b"]], [x.url, ["x-b"]],
    ]);
    assert.equal(collectSharedStylesheets([{ ...a, stylesheets: [x] }, { ...b, stylesheets: [{ ...x, conditions: [{ layer: "base" }] }] }]).length, 2);
    const frames = { ...x, css: "@keyframes pulse{to{opacity:.5}}" };
    assert.equal(collectSharedStylesheets([{ ...a, stylesheets: [frames], css: "@keyframes pulse{to{opacity:1}}" }, { ...b, stylesheets: [frames] }]).length, 2);
  });
});
