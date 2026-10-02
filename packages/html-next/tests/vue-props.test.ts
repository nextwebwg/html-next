import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { build } from "esbuild";

import { vuePropsArtifact } from "../src/generate.js";
import { parseTypedValue, parseTypeExpression } from "../src/type-system.js";

async function generatedChecker(): Promise<(value: unknown, type: ReturnType<typeof parseTypeExpression>, required: boolean, name: string, pattern?: string) => unknown> {
  const bundle = await build({
    stdin: { contents: vuePropsArtifact().content, loader: "ts", resolveDir: new URL("../src", import.meta.url).pathname },
    bundle: true, write: false, platform: "node", format: "esm",
  });
  const code = bundle.outputFiles[0]!.text;
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return module.checkedProp;
}

async function generatedModule(): Promise<Record<string, any>> {
  const bundle = await build({
    stdin: { contents: vuePropsArtifact().content, loader: "ts", resolveDir: new URL("../src", import.meta.url).pathname },
    bundle: true, write: false, platform: "node", format: "esm",
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString("base64")}`);
}

/** A native-named element with no validity API of its own, as some DOM implementations provide. */
function bareElement(localName: string) {
  const attributes = new Map<string, string>();
  return {
    localName,
    attributes,
    hasAttribute: (name: string) => attributes.has(name),
    setAttribute: (name: string, value: string) => { attributes.set(name, value); },
    removeAttribute: (name: string) => { attributes.delete(name); },
    toggleAttribute: (name: string, force: boolean) => { if (force) attributes.set(name, ""); else attributes.delete(name); return force; },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
}

describe("generated Vue prop validity", () => {
  it("gives a native-named element without validity its own API, without calling itself", async () => {
    const { vPropValidity } = await generatedModule();
    const field = bareElement("fieldset") as ReturnType<typeof bareElement> & { validity: { valid: boolean }, setCustomValidity(message: string): void };
    vPropValidity.mounted(field, { value: { contract: { props: {} }, values: {} } });
    assert.equal(field.validity.valid, true);
    field.setCustomValidity("Choose one.");
    assert.equal(field.validity.valid, false);
    assert.equal(field.attributes.has("data-invalid"), true);
    field.setCustomValidity("");
    assert.equal(field.validity.valid, true);
  });
});

describe("generated Vue prop boundary", () => {
  it("accepts typed values for every declared base type", async () => {
    const checkedProp = await generatedChecker();
    const samples: ReadonlyArray<[string, unknown]> = [
      ["keyword", "size-2"], ["url", "https://example.org/"], ["email", "ada@example.org"], ["email", "a@b"],
      ["date", "2026-09-29"], ["month", "2026-09"], ["week", "2026-W40"],
      ["time", "13:45"], ["datetime-local", "2026-09-29T13:45"],
      ["datetime", "2026-09-29T13:45Z"], ["color", "#663399"],
      ["color-hex", "#663399cc"], ["length", "1rem"], ["percentage", "25%"],
      ["duration", "200ms"],
    ];
    for (const [name, value] of samples) {
      assert.equal(checkedProp(value, parseTypeExpression(name), false, "value"), value, name);
    }
  });

  it("reads a bare boolean attribute as true, as HTML does", async () => {
    const checkedProp = await generatedChecker();
    assert.equal(checkedProp("", parseTypeExpression("boolean"), false, "decorative"), true);
    assert.equal(checkedProp("", parseTypeExpression("boolean"), true, "decorative"), true);
    assert.equal(checkedProp(false, parseTypeExpression("boolean"), false, "decorative"), false);
    assert.equal(checkedProp(undefined, parseTypeExpression("boolean"), false, "decorative"), null);
    assert.equal(checkedProp("", parseTypeExpression("number"), false, "count"), null);
  });

  it("keeps malformed functional colors out of the accepted value", async () => {
    const checkedProp = await generatedChecker();
    assert.equal(checkedProp("rgb(garbage)", parseTypeExpression("color"), false, "color"), null);
    assert.equal(checkedProp("color-mix(in srgb, red, blue)", parseTypeExpression("color"), false, "color"), null);
    assert.equal(checkedProp("rgb(102 51 153)", parseTypeExpression("color"), false, "color"), "rgb(102 51 153)");
  });

  it("passes typed strings to the component validity boundary", async () => {
    const checkedProp = await generatedChecker();
    const type = parseTypeExpression("string");
    assert.equal(checkedProp("ABC-1234", type, false, "sku"), "ABC-1234");
    assert.equal(checkedProp("xABC-1234", type, false, "sku"), "xABC-1234");
  });

  it("checks Vue values as typed values without HTML attribute coercion", async () => {
    const checkedProp = await generatedChecker();
    const samples: readonly (readonly [string, unknown])[] = [
      ["string", "hello"], ["string", 7],
      ["boolean", false], ["boolean", "false"],
      ["number", 42], ["number", "42"], ["number", Infinity],
      ["integer", 3], ["integer", 3.5],
      ["list(integer)", [1, 2]], ["list(integer)", "[1,2]"],
      ["object({ id: integer, label?: string })", { id: 2 }],
      ["object({ id: integer, label?: string })", "{ id: 2 }"],
    ];

    for (const [type, value] of samples) {
      const node = parseTypeExpression(type);
      const canonical = parseTypedValue(value, node, "$", "value");
      if (canonical.ok) assert.deepEqual(checkedProp(value, node, false, "value"), canonical.value, `${type}: valid value`);
      else assert.deepEqual(checkedProp(value, node, false, "value"), null, `${type}: invalid value is rejected`);
    }
  });

  it("distinguishes absent optional and required props", async () => {
    const checkedProp = await generatedChecker();
    const type = parseTypeExpression("number");
    assert.equal(checkedProp(undefined, type, false, "count"), null);
    assert.equal(checkedProp(null, type, false, "count"), null);
    assert.equal(checkedProp(undefined, type, true, "count"), null);
    assert.equal(checkedProp(null, type, true, "count"), null);
  });

  it("keeps the last accepted value while an invalid Vue prop input remains inspectable", async () => {
    const { checkedProp, propValidityState } = await generatedModule();
    const type = parseTypeExpression("number");
    const accepted: Record<string, unknown> = { count: 5 };
    assert.equal(checkedProp(2, type, false, "count", accepted), 2);
    assert.equal(checkedProp("oops", type, false, "count", accepted), 2);
    assert.equal(accepted.count, 2);
    const validity = propValidityState({
      contract: { props: { count: { type, required: false } } },
      values: { count: "oops" },
    }, "count");
    assert.equal(validity.badInput, true);
    assert.equal(checkedProp(7, type, false, "count", accepted), 7);
    assert.equal(accepted.count, 7);
  });
});
