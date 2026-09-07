import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { Html7DiagnosticError } from "../src/diagnostics.js";
import { parseComponent } from "../src/parser.js";

const fixtureUrl = new URL("./fixtures/looma-button.html", import.meta.url);

function expectDiagnostic(code: string, source: string): void {
  assert.throws(
    () => parseComponent(source, "component.html"),
    (error: unknown) =>
      error instanceof Html7DiagnosticError && error.diagnostic.code === code,
  );
}

function componentSource(
  template: string,
  props: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): string {
  const contract = {
    version: 1,
    name: "Example",
    tag: "demo-example",
    status: "early",
    summary: "An example component.",
    nativeElement: "button",
    props,
    ...overrides,
  };
  return `<html7-component>
    <script type="application/html7-contract+json">${JSON.stringify(contract)}</script>
    <template>${template}</template>
  </html7-component>`;
}

describe("parseComponent", () => {
  it("parses a Looma primitive into normalized IR", async () => {
    const source = await readFile(fixtureUrl, "utf8");
    const definition = parseComponent(source, "looma-button.html");

    assert.equal(definition.contract.name, "Button");
    assert.equal(definition.contract.nativeElement, "button");
    assert.equal(definition.template.name, "button");
    assert.deepEqual(definition.template.attributes, [
      { kind: "literal", name: "data-looma", value: "" },
      { kind: "attribute", name: "data-lm-variant", expression: "variant" },
      { kind: "attribute", name: "data-lm-size", expression: "size" },
    ]);
    assert.deepEqual(definition.template.children, [{ kind: "slot" }]);
    assert.match(definition.css, /all: revert/);
    assert.equal(definition.source.file, "looma-button.html");
  });

  it("normalizes parsed property bindings through the static DOM contract", () => {
    const source = componentSource(
      `<button .textContent="message"></button>`,
      {
        message: {
          type: "string",
          target: { property: "textContent" },
          description: "Button text.",
        },
      },
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
  });

  it("rejects missing, duplicate, and unknown definition blocks", () => {
    expectDiagnostic("H7S001", `<p>not a definition</p>`);
    expectDiagnostic(
      "H7S002",
      `<html7-component><template><button></button></template></html7-component>`,
    );
    const valid = componentSource(`<button><slot></slot></button>`);
    expectDiagnostic(
      "H7S003",
      valid.replace("</html7-component>", "<aside></aside></html7-component>"),
    );
    expectDiagnostic(
      "H7S002",
      valid.replace("<template>", "<template></template><template>"),
    );
  });

  it("reports malformed contract JSON as a source diagnostic", () => {
    expectDiagnostic(
      "H7S004",
      `<html7-component>
        <script type="application/html7-contract+json">{ nope }</script>
        <template><button></button></template>
      </html7-component>`,
    );
  });

  it("rejects multiple roots and a root that differs from nativeElement", () => {
    expectDiagnostic("H7T001", componentSource(`<button></button><button></button>`));
    expectDiagnostic("H7T002", componentSource(`<a></a>`));
  });

  it("rejects undeclared expressions and prop target mismatches", () => {
    expectDiagnostic(
      "H7T003",
      componentSource(`<button :title="missing"></button>`),
    );
    expectDiagnostic(
      "H7T004",
      componentSource(
        `<button :title="label"></button>`,
        {
          label: {
            type: "string",
            target: { attribute: "aria-label" },
            description: "Label.",
          },
        },
      ),
    );
  });

  it("rejects unsupported two-way bindings and unsafe raw HTML", () => {
    expectDiagnostic(
      "H7T005",
      componentSource(`<button bind:value="value"></button>`),
    );
    expectDiagnostic(
      "H7T007",
      componentSource(
        `<button .innerHTML="markup"></button>`,
        {
          markup: {
            type: "string",
            target: { property: "innerHTML" },
            description: "Markup.",
          },
        },
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

