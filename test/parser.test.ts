import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { HtmlDiagnosticError } from "../src/diagnostics.js";
import { parseComponent } from "../src/parser.js";

const fixtureUrl = new URL("./fixtures/x-button.html", import.meta.url);

function expectDiagnostic(code: string, source: string): void {
  assert.throws(
    () => parseComponent(source, "component.html"),
    (error: unknown) =>
      error instanceof HtmlDiagnosticError && error.diagnostic.code === code,
  );
}

// Targets are inferred from the bindings in `template`; `props` supplies the `<prop>`
// declarations (types, defaults, docs) that markup alone cannot carry.
function componentSource(
  template: string,
  props = "",
  attrs = `component="demo-example" status="early" summary="An example component."`,
): string {
  const group = props === "" ? "" : `<props>${props}</props>`;
  return `<template ${attrs}>${group}${template}</template>`;
}

describe("parseComponent", () => {
  it("normalizes the full component interface and named slot shapes", () => {
    const definition = parseComponent(
      `<template component="ui-combobox" status="early" summary="A composed field." controller="./combobox.js">` +
        `<defs>` +
        `<prop name="config" type="string">Property-only configuration.</prop>` +
        `<state name="query" :value="''"></state>` +
        `<computed name="empty" from="not query"></computed>` +
        `<event name="value-change" type="string"></event>` +
        `<method name="validate" returns="string" export="validate"></method>` +
        `</defs>` +
        `<div><slot name="start"><span>Start</span></slot><slot :name="query"></slot></div>` +
        `</template>`,
      "combobox.html",
    );

    assert.equal(definition.controller, "./combobox.js");
    assert.deepEqual(definition.declarations!.map(({ kind, name }) => [kind, name]), [
      ["state", "query"],
      ["computed", "empty"],
      ["event", "value-change"],
      ["method", "validate"],
    ]);
    const state = definition.declarations![0];
    const computed = definition.declarations![1];
    assert.ok(state?.kind === "state");
    assert.ok(computed?.kind === "computed");
    assert.deepEqual(state.expression?.dependencies, []);
    assert.deepEqual(computed.expression?.dependencies, ["query"]);
    assert.deepEqual(definition.slots!.map(({ name, dynamic, required }) => ({ name, dynamic, required })), [
      { name: "start", dynamic: false, required: false },
      { name: undefined, dynamic: true, required: true },
    ]);
  });

  it("rejects declaration collisions across the flat component scope", () => {
    expectDiagnostic(
      "HC020",
      `<template component="demo-example" status="early" summary="Collision.">` +
        `<defs><prop name="value" type="string">Value.</prop><state name="value"></state></defs>` +
        `<button :data-value="value"></button></template>`,
    );
  });

  it("parses a primitive into normalized IR", async () => {
    const source = await readFile(fixtureUrl, "utf8");
    const definition = parseComponent(source, "x-button.html");

    assert.equal(definition.contract.name, "XButton");
    assert.equal(definition.contract.tag, "x-button");
    assert.equal(definition.contract.nativeElement, "button");
    assert.equal(definition.template.name, "button");
    assert.deepEqual(definition.template.attributes, [
      { kind: "literal", name: "data-x-button", value: "" },
      { kind: "attribute", name: "data-variant", expression: "variant" },
      { kind: "attribute", name: "data-size", expression: "size" },
    ]);
    assert.deepEqual(definition.template.children, [{ kind: "slot" }]);
    assert.match(definition.css, /all: revert/);
    assert.equal(definition.source.file, "x-button.html");
  });

  it("infers property targets through the static DOM contract", () => {
    const source = componentSource(
      `<button .textContent="message"></button>`,
      `<prop name="message" type="string">Button text.</prop>`,
    );
    const definition = parseComponent(source, "property.html");
    assert.deepEqual(definition.template.attributes, [
      {
        kind: "property",
        key: "textcontent",
        name: "textContent",
        expression: "message",
      },
    ]);
    assert.deepEqual(definition.contract.props.message?.target, {
      property: "textContent",
    });
  });

  it("rejects missing, duplicate, and malformed carriers", () => {
    expectDiagnostic("HS001", `<p>not a definition</p>`);
    expectDiagnostic(
      "HS001",
      `<template component="a-one"><button></button></template>` +
        `<template component="a-two"><button></button></template>`,
    );
    expectDiagnostic(
      "HS002",
      `<template component="demo-example" status="early" summary="Two prop groups.">` +
        `<props></props><props></props><button><slot></slot></button></template>`,
    );
  });

  it("rejects zero or multiple markup roots", () => {
    expectDiagnostic("HT001", componentSource(`<button></button><button></button>`));
    expectDiagnostic("HT001", componentSource(`<button><slot></slot></button><aside></aside>`));
  });

  it("infers a non-button native root from the markup", () => {
    const definition = parseComponent(componentSource(`<a><slot></slot></a>`), "anchor.html");
    assert.equal(definition.contract.nativeElement, "a");
  });

  it("rejects undeclared expressions and props bound to conflicting targets", () => {
    expectDiagnostic("HT003", componentSource(`<button :title="missing"></button>`));
    expectDiagnostic(
      "HT004",
      componentSource(
        `<button :title="label" :aria-label="label"></button>`,
        `<prop name="label" type="string">Label.</prop>`,
      ),
    );
  });

  it("rejects props declared without a name, type, or binding", () => {
    expectDiagnostic(
      "HC010",
      componentSource(`<button :data-x="v"></button>`, `<prop type="string">No name.</prop>`),
    );
    expectDiagnostic(
      "HC013",
      componentSource(`<button :data-x="v"></button>`, `<prop name="v">No type.</prop>`),
    );
    expectDiagnostic(
      "HC018",
      componentSource(
        `<button><slot></slot></button>`,
        `<prop name="ghost" type="string">Never bound.</prop>`,
      ),
    );
  });

  it("rejects unsupported two-way bindings and unsafe raw HTML", () => {
    expectDiagnostic("HT005", componentSource(`<button bind:value="value"></button>`));
    expectDiagnostic(
      "HT007",
      componentSource(
        `<button .innerHTML="markup"></button>`,
        `<prop name="markup" type="string">Markup.</prop>`,
      ),
    );
  });

  it("rejects executable literal attributes and unsafe property sinks", () => {
    for (const attribute of [
      "@click",
      "v-html",
      "#default",
      "on:click",
      "use:action",
      "transition:fade",
      "animate:flip",
      "onclick",
    ]) {
      expectDiagnostic("HT010", componentSource(`<button ${attribute}="payload"></button>`));
    }

    expectDiagnostic(
      "HT007",
      componentSource(
        `<button .outerHTML="markup"></button>`,
        `<prop name="markup" type="string">Replacement markup.</prop>`,
      ),
    );
    expectDiagnostic(
      "HT007",
      componentSource(
        `<iframe .srcdoc="markup"></iframe>`,
        `<prop name="markup" type="string">Embedded markup.</prop>`,
      ),
    );
  });

  it("rejects invalid default-slot shapes and reserved language elements", () => {
    expectDiagnostic(
      "HT008",
      componentSource(`<button><slot></slot><slot></slot></button>`),
    );
    expectDiagnostic(
      "HT009",
      componentSource(`<button><if test="ready"></if></button>`),
    );
  });
});
