import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { transform } from "esbuild";

import { vuePropsArtifact } from "../src/generate.js";
import { parseTypedValue, parseTypeExpression } from "../src/type-system.js";

async function generatedChecker(): Promise<(value: unknown, type: ReturnType<typeof parseTypeExpression>, required: boolean, name: string) => unknown> {
  const { code } = await transform(vuePropsArtifact().content, { loader: "ts", format: "esm" });
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return module.checkedProp;
}

describe("generated Vue prop boundary", () => {
  it("matches the canonical typed-value parser across scalar, union, and structured values", async () => {
    const checkedProp = await generatedChecker();
    const samples: readonly (readonly [string, unknown])[] = [
      ["string", "hello"], ["string", 7],
      ["boolean", ""], ["boolean", "true"], ["boolean", "false"], ["boolean", "no"],
      ["number", "42"], ["number", " "], ["number", "abc"], ["number", Infinity],
      ["integer", "3"], ["integer", 3.5],
      ["null", null], ["null", "null"], ["absent", null],
      ["unknown", { any: [1] }], ["function", () => 1], ["function", "run"],
      ["'start' | 'end'", "start"], ["'start' | 'end'", "middle"],
      ["number | null", "2"], ["number | null", null],
      ["list(integer)", "[1,\"2\"]"], ["list(integer)", "[1,2.5]"], ["list(integer)", "not-json"],
      ["record(number)", '{"a":"2","b":3}'], ["record(number)", '{"a":"oops"}'],
      ["object({ id: integer, label?: string, ... })", '{"id":"2","extra":true}'],
      ["object({ id: integer, label?: string, ... })", '{"id":2,"label":7}'],
      ["object({ id: integer })", '{"id":2,"extra":true}'],
      ["trusted-html", { kind: "trusted-html", value: "<b>safe</b>" }],
      ["trusted-script", "alert(1)"],
    ];

    for (const [type, value] of samples) {
      const node = parseTypeExpression(type);
      const canonical = parseTypedValue(value, node);
      if (canonical.ok) assert.deepEqual(checkedProp(value, node, false, "value"), canonical.value, `${type}: valid value`);
      else assert.throws(
        () => checkedProp(value, node, false, "value"),
        (error) => error instanceof Error && error.name === "HtmlDiagnosticError" &&
          error.message === `HR002: A prop invocation value does not satisfy its declared type. ${canonical.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
        `${type}: invalid value`,
      );
    }
  });

  it("distinguishes absent optional and required props", async () => {
    const checkedProp = await generatedChecker();
    const type = parseTypeExpression("number");
    assert.equal(checkedProp(undefined, type, false, "count"), undefined);
    assert.throws(
      () => checkedProp(undefined, type, true, "count"),
      (error) => error instanceof Error && error.name === "HtmlDiagnosticError" &&
        error.message === "HC020: Required prop `count` was not provided.",
    );
  });
});
