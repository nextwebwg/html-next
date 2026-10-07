import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { parseFragment, serialize } from "parse5";

import { sanitizeServerHTML } from "../src/sanitize-server.js";
import { cases } from "./sanitize-cases.js";

describe("server HTML Sanitizer safe default", () => {
  for (const { input, expected } of cases) {
    it(`matches native setHTML() for ${input.slice(0, 24)}`, () => {
      const output = sanitizeServerHTML(input);
      assert.equal(output, expected);
      assert.equal(serialize(parseFragment(output)), output, "SSR serialization reparses to the same tree");
    });
  }

  it("uses the destination element's parsing context", () => {
    assert.equal(sanitizeServerHTML("<tr><td>Cell</td></tr>", "tbody"), "<tr><td>Cell</td></tr>");
    assert.equal(sanitizeServerHTML("<tr><td>Cell</td></tr>", "div"), "Cell");
  });
});
