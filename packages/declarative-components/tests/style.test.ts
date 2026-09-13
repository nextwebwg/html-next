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
