import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";

import { HtmlDiagnosticError } from "../src/diagnostics.js";
import { parseComponent } from "../src/source-parser.js";

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

  it("keeps external event names separate from value bindings", () => {
    const definition = parseComponent(
      `<template component="demo-example" status="early" summary="Event namespace.">` +
        `<defs><prop name="open" type="boolean" default="false">Open.</prop>` +
        `<event name="open" type="boolean"></event></defs>` +
        `<button :data-open="open"></button></template>`,
    );
    assert.deepEqual(definition.declarations?.map((declaration) => declaration.kind), ["event"]);
  });

  it("parses a primitive into normalized IR", async () => {
    const source = await readFile(fixtureUrl, "utf8");
    const definition = parseComponent(source, "x-button.html");

    assert.equal(definition.contract.name, "XButton");
    assert.equal(definition.contract.tag, "x-button");
    assert.equal(definition.contract.nativeElement, "button");
    assert.equal(definition.template.name, "button");
    assert.deepEqual(definition.template.attributes.map((attribute) => {
      if (attribute.kind !== "attribute") return attribute;
      return { kind: attribute.kind, name: attribute.name, expression: attribute.expression };
    }), [
      { kind: "literal", name: "data-x-button", value: "" },
      { kind: "attribute", name: "data-variant", expression: "variant" },
      { kind: "attribute", name: "data-size", expression: "size" },
    ]);
    assert.deepEqual(
      definition.template.attributes
        .filter((attribute) => attribute.kind === "attribute")
        .map((attribute) => attribute.expressionPlan?.dependencies),
      [["variant"], ["size"]],
    );
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
    const property = definition.template.attributes[0];
    assert.ok(property?.kind === "property");
    assert.deepEqual({
      kind: property.kind,
      key: property.key,
      name: property.name,
      expression: property.expression,
    }, [
      {
        kind: "property",
        key: "textcontent",
        name: "textContent",
        expression: "message",
      },
    ][0]);
    assert.deepEqual(property.expressionPlan?.dependencies, ["message"]);
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

  it("parses state-rooted two-way bindings, flow, content, refs, and events", () => {
    const definition = parseComponent(
      `<template component="demo-example" status="early" summary="Bindings.">` +
        `<defs><state name="form" :value="{ email: '' }"></state>` +
        `<handler name="save"></handler></defs>` +
        `<form><input bind:value="form.email" $ref="email" on:input.passive="save">` +
        `<output $if="form.email" $value="form.email"></output></form></template>`,
    );
    const input = definition.template.children[0];
    const output = definition.template.children[1];
    assert.ok(input?.kind === "element");
    assert.ok(output?.kind === "element");
    assert.equal(input.attributes[0]?.kind, "attribute");
    assert.equal(input.attributes[0]?.kind === "attribute" && input.attributes[0].twoWay, true);
    assert.equal(input.ref, "email");
    assert.deepEqual(input.events, [{ name: "input", handler: "save", modifiers: ["passive"] }]);
    assert.equal(output.flow?.kind, "if");
    assert.equal(output.flow?.kind === "if" && output.flow.test, "form.email");
    assert.deepEqual(
      output.flow?.kind === "if" ? output.flow.testPlan?.dependencies : undefined,
      ["form.email"],
    );
    assert.equal(output.attributes[0]?.kind, "directive");
  });

  it("normalizes enhanced forms and makes their request state available to expressions", () => {
    const definition = parseComponent(
      `<template component="x-editor" status="early" summary="Editor.">` +
        `<defs><state name="post" :value="{ id: '42', title: 'Draft' }"></state>` +
        `<handler name="saved"></handler></defs>` +
        `<form name="save" method="post" src="/api/posts/{id}" on:success="saved">` +
        `<param name="id" :value="post.id"></param><param name="title" :value="post.title"></param>` +
        `<button>Save</button><output $value="save.pending"></output></form></template>`,
    );
    const form = definition.declarations?.find((declaration) => declaration.kind === "form");
    assert.ok(form?.kind === "form");
    assert.equal(form.source, "/api/posts/{id}");
    assert.deepEqual(form.parameters.map((parameter) => parameter.name), ["id", "title"]);
    assert.equal(definition.template.children.some(
      (child) => child.kind === "element" && child.name === "param",
    ), false);
  });

  it("normalizes the complete declaration and template language into one IR", () => {
    const definition = parseComponent(
      `<template component="x-results" status="experimental" summary="Search results." controller="./results.js">` +
        `<defs>` +
        `<prop name="query" type="string" required>Search query.</prop>` +
        `<state name="form" :value="{ selected: 0 }"></state>` +
        `<computed name="hasQuery" from="query != ''"></computed>` +
        `<data name="results" src="/api/search" type="json" schema="./result.schema.json" debounce="150" poll="30000">` +
        `<param name="q" :value="query"></param></data>` +
        `<event name="selection-change" type="number" bubbles="false" composed="false" cancelable="true"></event>` +
        `<method name="refresh" export="refresh" returns="promise(undefined)"></method>` +
        `<handler name="select">` +
        `<set name="form.selected" :value="form.selected + 1" $if="hasQuery"></set>` +
        `<validate target="search"></validate><focus ref="search"></focus>` +
        `<dispatch event="selection-change" :value="form.selected"></dispatch>` +
        `</handler></defs>` +
        `<section :data-ready="hasQuery" class:active="hasQuery" style:opacity="hasQuery" $ref="root">` +
        `<input .value="query" bind:data-index="form.selected" $ref="search" on:input.capture.once="select">` +
        `<ol><li $each="row, i of results.value" $where="row.visible" $sort="-score,name" $limit="3" $key="row.id">` +
        `<slot :name="row.id"><span $value="i"></span></slot></li></ol>` +
        `<div $with="form as current"><output $value="current.selected"></output></div>` +
        `<div $match="form as current"><span $when="current.selected > 0">Selected</span><span $else>None</span></div>` +
        `</section><style>:scope { display: block; }</style></template>`,
      "results.html",
    );

    assert.deepEqual(definition.root, { kind: "native", element: "section", choices: ["section"] });
    assert.equal(definition.controller, "./results.js");
    assert.match(definition.css, /display: block/);

    const declarations = definition.declarations ?? [];
    const data = declarations.find((declaration) => declaration.kind === "data");
    const handler = declarations.find((declaration) => declaration.kind === "handler");
    assert.ok(data?.kind === "data");
    assert.deepEqual(
      {
        source: data.source,
        type: data.type,
        schema: data.schema,
        debounce: data.debounce,
        poll: data.poll,
        parameters: data.parameters.map((parameter) => ({
          name: parameter.name,
          dependencies: parameter.expression.dependencies,
        })),
      },
      {
        source: "/api/search",
        type: "json",
        schema: "./result.schema.json",
        debounce: "150",
        poll: "30000",
        parameters: [{ name: "q", dependencies: ["query"] }],
      },
    );
    assert.ok(handler?.kind === "handler");
    assert.deepEqual(handler.steps.map((step) => step.kind), ["set", "validate", "focus", "dispatch"]);
    assert.deepEqual(handler.steps[0]?.kind === "set" && handler.steps[0].writablePath, ["form", "selected"]);

    const input = definition.template.children[0];
    const list = definition.template.children[1];
    assert.ok(input?.kind === "element");
    assert.deepEqual(input.events, [{ name: "input", handler: "select", modifiers: ["capture", "once"] }]);
    assert.equal(input.attributes.some((attribute) => attribute.kind === "property" && attribute.name === "value"), true);
    assert.equal(input.attributes.some((attribute) => attribute.kind === "attribute" && attribute.twoWay), true);
    assert.ok(list?.kind === "element");
    const item = list.children[0];
    assert.ok(item?.kind === "element" && item.flow?.kind === "each");
    assert.deepEqual(item.flow?.kind === "each" && item.flow.keyPlan?.dependencies, ["row.id"]);
    assert.deepEqual(definition.slots, [{ dynamic: true, required: false }]);
  });

  it("records polymorphic native roots and delegated component roots", () => {
    const polymorphic = parseComponent(
      componentSource(`<button as="button|a" :aria-label="label"></button>`, `<prop name="label" type="string">Label.</prop>`),
    );
    assert.deepEqual(polymorphic.root, { kind: "native", element: "button", choices: ["button", "a"] });

    const delegated = parseComponent(
      `<template component="x-primary" status="early" summary="Delegates.">` +
        `<x-base-button><slot></slot></x-base-button></template>`,
    );
    assert.deepEqual(delegated.root, { kind: "component", tag: "x-base-button" });
  });

  it("rejects non-state two-way bindings and unsafe raw HTML", () => {
    expectDiagnostic(
      "HT005",
      `<template component="demo-example" status="early" summary="Read only.">` +
        `<defs><prop name="value" type="string">Value.</prop></defs>` +
        `<button bind:value="value"></button></template>`,
    );
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
    expectDiagnostic("HT007", componentSource(`<a href="javascript:alert(1)">Bad</a>`));
    expectDiagnostic("HT007", componentSource(`<iframe srcdoc="<script>bad()</script>"></iframe>`));
    expectDiagnostic("HT009", componentSource(`<div><script>bad()</script></div>`));
    expectDiagnostic(
      "HT009",
      componentSource(`<button></button>`, `<script>bad()</script>`),
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
