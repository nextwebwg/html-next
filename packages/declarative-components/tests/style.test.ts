import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { transformComponentStyles } from "../src/style.js";

describe("transformComponentStyles", () => {
  it("produces deterministic provenance-scoped fallback selectors", () => {
    const css = [
      ":scope, article { color: var(--tone); }",
      "article > .lead + x-badge:hover { margin: 1px; }",
      "article:has(.lead > x-icon:invalid) { padding: 2px; }",
      "@media (width > 10rem) { .lead:user-invalid { opacity: .5; } }",
      "@keyframes pulse { from { opacity: 0 } to { opacity: 1 } }",
    ].join("\n");

    const output = transformComponentStyles(css, "x-card", { mode: "attribute" });

    assert.match(output, /data-component-root~="x-card"[\s\S]*data-component~="x-card"/);
    assert.match(output, /article:where\(\[data-component~="x-card"\]\)/);
    assert.match(output, /data-component-root~="x-badge"[\s\S]*:hover:where\(\[data-component~="x-card"\]\)/);
    assert.match(output, /:has\(\.lead > [\s\S]*data-component-root~="x-icon"[\s\S]*:is\(:invalid, \[data-invalid\]\):where\(\[data-component~="x-card"\]\)\)/);
    assert.match(output, /@media[\s\S]*\.lead:is\(:user-invalid, \[data-user-invalid\]\):where\(\[data-component~="x-card"\]\)/);
    assert.match(output, /@keyframes pulse \{ from \{ opacity: 0 \} to \{ opacity: 1 \} \}/);
  });

  it("uses instance roots and the corrected inclusive lower boundaries for native scope", () => {
    const output = transformComponentStyles(
      ".child, x-nested:invalid { color: red; }",
      "x-parent",
      { mode: "scope" },
    );

    assert.match(output, /^@scope \(\[data-component-root~="x-parent"\]\) to \(:scope \[data-component-root\] > \*, \[data-slotted\]\) \{/);
    assert.match(output, /data-component-root~="x-nested"[\s\S]*:is\(:invalid, \[data-invalid\]\)/);
    assert.doesNotMatch(output, /\.child\[data-component~/);
  });

  it("compiles :slotted() to a self-contained projected-subtree selector", () => {
    const out = transformComponentStyles(":slotted(button) { color: red; }", "x-card", {
      mode: "attribute",
    });
    assert.match(
      out,
      /\[data-component-root~="x-card"\] :where\(\[data-slotted\], \[data-slotted\] \*\):is\(button\) \{ color: red; \}/,
    );
    // projected content is not authored by x-card, so slotted rules carry no subject provenance
    assert.doesNotMatch(out, /:where\(\[data-component~="x-card"\]\)/);
  });

  it("anchors :slotted(> ...) to the top-level projected roots", () => {
    assert.match(
      transformComponentStyles(":slotted(> *) { margin: 0; }", "x-card"),
      /\[data-component-root~="x-card"\] \[data-slotted\] \{ margin: 0; \}/,
    );
    assert.match(
      transformComponentStyles(":slotted(> button) { margin: 0; }", "x-card"),
      /\[data-component-root~="x-card"\] \[data-slotted\]:is\(button\) \{ margin: 0; \}/,
    );
  });

  it("folds a :scope state condition into the projected anchor", () => {
    assert.match(
      transformComponentStyles(':scope[data-variant="solid"] :slotted(button) { background: blue; }', "x-card"),
      /\[data-component-root~="x-card"\]\[data-variant="solid"\] :where\(\[data-slotted\], \[data-slotted\] \*\):is\(button\) \{ background: blue; \}/,
    );
    // complex root conditions (pseudo-classes, functional pseudos) fold too
    assert.match(
      transformComponentStyles(":scope:hover:not([data-open]) :slotted(button) { color: red; }", "x-card"),
      /\[data-component-root~="x-card"\]:hover:not\(\[data-open\]\) :where\(\[data-slotted\], \[data-slotted\] \*\):is\(button\) \{ color: red; \}/,
    );
  });

  it("emits :slotted() rules outside the component @scope in native mode", () => {
    const out = transformComponentStyles(
      ".lead { color: gray; } :slotted(button) { all: unset; }",
      "x-card",
      { mode: "scope" },
    );
    assert.match(out, /^@scope \([\s\S]*\.lead[\s\S]*\}\n\s*\[data-component-root~="x-card"\] /);
    assert.match(out, /\}\n\s*\[data-component-root~="x-card"\] :where\(\[data-slotted\],[\s\S]*:is\(button\) \{ all: unset; \}$/);
  });

  it("does not duplicate validity mirrors when transformed more than once", () => {
    const once = transformComponentStyles(".field:invalid { color: red; }", "x-field", {
      mode: "attribute",
    });
    const twice = transformComponentStyles(once, "x-field", { mode: "attribute" });

    assert.equal(twice, once);
    assert.match(
      transformComponentStyles(".field:invalid:hover { color: red; }", "x-field"),
      /:is\(:invalid, \[data-invalid\]\):hover:where\(\[data-component~/,
    );
  });
});
