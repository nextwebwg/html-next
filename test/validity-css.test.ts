import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rewriteValiditySelectors } from "../src/validity-css.js";

describe("rewriteValiditySelectors", () => {
  it("mirrors validity pseudo-classes in selectors and nested grouping rules", () => {
    const source =
      `.field:invalid, form:not(:valid) { color: red; }\n` +
      `@media (width > 10rem) { .field:valid, .field:user-invalid { color: green; } }`;
    const rewritten = rewriteValiditySelectors(source);

    assert.match(rewritten, /\.field:is\(:invalid, \[data-invalid\]\)/);
    assert.match(rewritten, /form:not\(:is\(:valid, \[data-valid\]\)\)/);
    assert.match(rewritten, /@media[\s\S]*\.field:is\(:valid, \[data-valid\]\)/);
    assert.match(rewritten, /\.field:is\(:user-invalid, \[data-user-invalid\]\)/);
  });

  it("does not rewrite declaration values, strings, comments, or longer pseudo names", () => {
    const source =
      `.field:invalid-state { content: ":invalid"; --example: :invalid; }\n` +
      `/* :invalid */ .field[title=":valid"] { color: red; }`;

    assert.equal(rewriteValiditySelectors(source), source);
  });
});
