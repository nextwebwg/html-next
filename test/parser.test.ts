import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { Html7DiagnosticError } from "../src/diagnostics.js";
import { parseComponent } from "../src/parser.js";

const fixtureUrl = new URL("./fixtures/x-button.html", import.meta.url);

function expectDiagnostic(code: string, source: string): void {
  assert.throws(
    () => parseComponent(source, "component.html"),
    (error: unknown) =>
      error instanceof Html7DiagnosticError && error.diagnostic.code === code,
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
    expectDiagnostic("H7S001", `<p>not a definition</p>`);
    expectDiagnostic(
      "H7S001",
      `<template component="a-one"><button></button></template>` +
        `<template component="a-two"><button></button></template>`,
    );
    expectDiagnostic(
      "H7S002",
      `<template component="demo-example" status="early" summary="Two prop groups.">` +
        `<props></props><props></props><button><slot></slot></button></template>`,
    );
  });

  it("rejects zero or multiple markup roots", () => {
    expectDiagnostic("H7T001", componentSource(`<button></button><button></button>`));
    expectDiagnostic("H7T001", componentSource(`<button><slot></slot></button><aside></aside>`));
  });

  it("infers a non-button native root from the markup", () => {
    const definition = parseComponent(componentSource(`<a><slot></slot></a>`), "anchor.html");
    assert.equal(definition.contract.nativeElement, "a");
  });

  it("rejects undeclared expressions and props bound to conflicting targets", () => {
    expectDiagnostic("H7T003", componentSource(`<button :title="missing"></button>`));
    expectDiagnostic(
      "H7T004",
      componentSource(
        `<button :title="label" :aria-label="label"></button>`,
        `<prop name="label" type="string">Label.</prop>`,
      ),
    );
  });

  it("rejects props declared without a name, type, or binding", () => {
    expectDiagnostic(
      "H7C010",
      componentSource(`<button :data-x="v"></button>`, `<prop type="string">No name.</prop>`),
    );
    expectDiagnostic(
      "H7C013",
      componentSource(`<button :data-x="v"></button>`, `<prop name="v">No type.</prop>`),
    );
    expectDiagnostic(
      "H7C018",
      componentSource(
        `<button><slot></slot></button>`,
        `<prop name="ghost" type="string">Never bound.</prop>`,
      ),
    );
  });

  it("rejects unsupported two-way bindings and unsafe raw HTML", () => {
    expectDiagnostic("H7T005", componentSource(`<button bind:value="value"></button>`));
    expectDiagnostic(
      "H7T007",
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
      expectDiagnostic("H7T010", componentSource(`<button ${attribute}="payload"></button>`));
    }

    expectDiagnostic(
      "H7T007",
      componentSource(
        `<button .outerHTML="markup"></button>`,
        `<prop name="markup" type="string">Replacement markup.</prop>`,
      ),
    );
    expectDiagnostic(
      "H7T007",
      componentSource(
        `<iframe .srcdoc="markup"></iframe>`,
        `<prop name="markup" type="string">Embedded markup.</prop>`,
      ),
    );
  });

  it("rejects invalid default-slot shapes and reserved language elements", () => {
    expectDiagnostic(
      "H7T008",
      componentSource(`<button><slot></slot><slot></slot></button>`),
    );
    expectDiagnostic(
      "H7T009",
      componentSource(`<button><if test="ready"></if></button>`),
    );
  });
});
