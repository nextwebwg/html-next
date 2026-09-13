import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { migrateLoomaStyles } from "../src/migrate/looma-css.js";

describe("Looma compatibility CSS migration", () => {
  it("targets provenance roots, reflected props, direct native roots, and authored surfaces", () => {
    const css = `ui-button[variant="solid"] > button:hover, ui-badge > .badge__surface, ui-input > input { color: red; }`;
    assert.equal(migrateLoomaStyles(css, [
      { tag: "ui-button", element: "button", classes: [], props: ["variant"] },
      { tag: "ui-badge", element: "span", classes: ["badge__surface"], props: [] },
      { tag: "ui-input", element: "div", classes: ["input"], props: [] },
    ]), `:is(:where([data-component-root~="ui-button"]), ui-button)[data-variant="solid"]:hover, :is(:where([data-component-root~="ui-badge"]), ui-badge).badge__surface, :is(:where([data-component-root~="ui-input"]), ui-input) > input { color: red; }`);
  });
});
