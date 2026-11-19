import assert from "node:assert/strict";
import { transform } from "esbuild";
import { JSDOM } from "jsdom";
import { describe, it } from "vitest";

import { DECIMAL_SOURCE } from "../src/generated/decimal-source.js";
import { compileExpression } from "../src/expression.js";
import { createRenderer } from "../src/server.js";
import { numericDefinitions } from "./numeric-fixture.js";
import { Lowering, mayProduceInvalidResult, type Scope, type Static } from "../src/targets/vue-lowering.js";


describe("finite numeric results", () => {
  it("leaves an initially invalid computed value null and preserves authored attributes in Node rendering", async () => {
    const renderer = createRenderer({ workers: 1 });
    try {
      const { html } = await renderer.render('<ssr-finite-results></ssr-finite-results>', { definitions: numericDefinitions });
      const document = new JSDOM(html).window.document;
      assert.equal(document.querySelector("#computed")!.textContent, "");
      assert.equal(document.querySelector("#direct")!.textContent, "");
      assert.equal(document.querySelector("#child")!.textContent, "5");
      assert.equal(document.querySelector("#scoped")!.textContent, "5");
      assert.equal(document.querySelector("#scoped-missing")!.textContent, "true");
      assert.equal(document.querySelector("#attribute")!.getAttribute("data-value"), "authored");
    } finally { await renderer.close(); }
  });

  for (const typed of [true, false]) {
    it(`rejects overflow and undefined numeric results in shared framework lowering (${typed ? "typed" : "unknown"} inputs)`, async () => {
      const names = ["huge", "zero", "missing"];
      const staticNumber: Static = { type: { kind: "terminal", name: "number" }, nullable: false };
      const scope: Scope = { code: new Map(names.map(name => [name, `data.${name}`])),
        types: new Map(typed ? names.filter(name => name !== "missing").map(name => [name, staticNumber]) : []) };
      for (const expression of ["1 / 0", "0 / $zero", "1 % $zero", "$huge + $huge", "-$huge - $huge", "$huge * 2",
        "default(1 / 0, 7)", "concat('value:', 1 / 0)", "not (1 / 0)", "(1 / 0) = 1", "(1 / 0) ? 1 : 2", "(1 / 0) + 2",
        "true and (1 / 0)", "false or (1 / 0)", "1 / 3", "$missing / 2", "$huge + 0.1", "0.1 - $huge"]) {
        const ast = compileExpression(expression).ast;
        if (!["$huge + 0.1", "0.1 - $huge"].includes(expression)) assert.equal(mayProduceInvalidResult(ast, scope), true, expression);
        const lowering = new Lowering();
        const value = lowering.value(ast, scope);
        const compiled = await transform(`${DECIMAL_SOURCE}\n${lowering.fallbacks().join("\n")}\nmodule.exports = (data: any) => ${value};`, { loader: "ts", format: "cjs" });
        const module = { exports: undefined as unknown as (data: object) => unknown };
        new Function("module", compiled.code)(module);
        const expected = expression === "1 / 3" ? 1 / 3 : expression === "$missing / 2" ? undefined
          : expression === "$huge + 0.1" ? Number.MAX_VALUE : expression === "0.1 - $huge" ? -Number.MAX_VALUE : Symbol.for("html-next.invalid-result");
        assert.equal(module.exports({ huge: Number.MAX_VALUE, zero: 0 }), expected, expression);
      }
    });
  }
});
