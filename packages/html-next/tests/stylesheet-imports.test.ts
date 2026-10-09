import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { loadNodeComponents } from "../src/node-loader.js";
import { compileComponentStylesForBuild, compileComponentGraphStylesForBuild, compileSharedComponentStylesForBuild } from "../src/component-styles-build.js";
import { collectSharedStylesheets, wrapStylesheetConditions } from "../src/stylesheet-resources.js";
import { parseComponent } from "../src/source-parser.js";
import { renderComponents } from "../src/server.js";
import { normalizeStylesheetNamespacesForBuild, parseStylesheetForBuild } from "../src/stylesheet-resources-build.js";

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

  it("preserves imported default and conflicting named namespaces through combined SSR delivery", async () => {
    const files: Record<string, string> = {
      "file:///pkg/app.html": '<template component="x-a"><div></div><style>@import "svg.css" layer(base); @import "html.css"; p { color: blue; }</style></template>',
      "file:///pkg/svg.css": '@namespace "http://www.w3.org/2000/svg"; @namespace n "http://www.w3.org/2000/svg"; rect, .shape, n|circle { fill: red; }',
      "file:///pkg/html.css": '@namespace n "http://www.w3.org/1999/xhtml"; n|p { color: green; }',
    };
    const graph = await loadNodeComponents(["file:///pkg/app.html"], { readComponent: async url => ({ url, source: files[url]! }) });
    const definitions = [...graph.nodes.values()].map(node => node.definition);
    const css = compileComponentGraphStylesForBuild(definitions);
    const namespaces = [...css.matchAll(/@namespace ([^ ]+) "([^"]+)";/g)];
    assert.equal(namespaces.length, 2);
    assert.equal(new Set(namespaces.map(match => match[1])).size, 2);
    assert.equal(css.slice(0, css.indexOf("@layer")).match(/@namespace/g)?.length, 2);
    assert.doesNotMatch(css, /@namespace "/);
    const svg = namespaces.find(match => match[2]!.endsWith("svg"))![1];
    assert.match(css, new RegExp(`${svg}\\|rect`));
    assert.match(css, new RegExp(`${svg}\\|\\*\\.shape`));
    assert.match(css, /p \{ color: blue/);
    assert.equal((await renderComponents('<x-a></x-a>', { definitions })).css.trim(), css.trim());
  });

  it("keeps namespace identifiers, attributes, nested selector functions and at-rule preludes sheet-local", () => {
    const css = normalizeStylesheetNamespacesForBuild(`
      @namespace url("urn:svg");
      @namespace n "urn:old";
      @namespace n "urn:svg";
      @namespace a "urn:attributes";
      n|rect[a|href][href="n|keep"] { content: "n|leave"; }
      *|*:is(.html, n|rect):not(.skip) { fill: green; }
      rect:has(> .shape):nth-child(2 of .shape) { fill: red; }
      @scope (:is(:where(n|svg))) to (.limit) {
        @supports selector(:is(:where(n|rect))) {
          rect { fill: blue; }
        }
      }
      @keyframes move { from { opacity: 0; } to { opacity: 1; } }
    `);
    const namespaces = [...css.matchAll(/@namespace ([^ ]+) "([^"]+)";/g)];
    const svg = namespaces.find(match => match[2] === "urn:svg")![1];
    const attributes = namespaces.find(match => match[2] === "urn:attributes")![1];
    assert.ok(css.includes(`${svg}|rect[${attributes}|href][href="n|keep"]`));
    assert.ok(css.includes(`*|*:is(.html, ${svg}|rect):not(.skip)`));
    assert.ok(css.includes(`${svg}|rect:has(> ${svg}|*.shape):nth-child(2 of ${svg}|*.shape)`));
    assert.ok(css.includes(`@scope (${svg}|*:is(:where(${svg}|svg))) to (${svg}|*.limit)`));
    assert.ok(css.includes(`selector(${svg}|*:is(:where(${svg}|rect)))`));
    assert.match(css, /content: "n\|leave"/);
    assert.match(css, /from \{ opacity: 0; \} to \{ opacity: 1;/);
    assert.doesNotMatch(css, /file:|@namespace url/);
  });

  it("decodes escaped namespace identifiers and leaves URI identifiers independent of asset bases", () => {
    const css = parseStylesheetForBuild(String.raw`@namespace n url(urn\3a svg); n|rect { fill: red; }`).css;
    assert.match(css, /@namespace ([^ ]+) "urn:svg";/);
    const prefix = /@namespace ([^ ]+)/.exec(css)![1];
    assert.ok(css.includes(`${prefix}|rect`));
    assert.doesNotMatch(css, /url\(/);
  });

  it("ignores late source namespaces even when an author uses a generated-looking prefix", () => {
    const css = normalizeStylesheetNamespacesForBuild('p { color: blue; } @namespace htmlnextns0078 "x"; htmlnextns0078|rect { fill: red; }');
    assert.doesNotMatch(css, /@namespace/);
    assert.match(css, /p \{ color: blue; \}/);
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
