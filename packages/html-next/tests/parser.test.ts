import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";

import { HtmlDiagnosticError } from "../src/diagnostics.js";
import { validateLiteralAttributeName } from "../src/language.js";
import { parseComponent } from "../src/source-parser.js";
import { normalizeType, parseTypedValue } from "../src/type-system.js";

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
    assert.ok(Object.isFrozen(definition));
    assert.ok(Object.isFrozen(definition.contract));
    assert.ok(Object.isFrozen(definition.contract.props));
  });

  it("treats status and summary as optional", () => {
    const definition = parseComponent('<template component="x-plain"><div></div></template>', "plain.html");
    assert.equal(definition.contract.status, undefined);
    assert.equal(definition.contract.summary, undefined);
  });

  it("accepts prop names that exist on Object.prototype", () => {
    const definition = parseComponent(
      componentSource(
        `<button :data-constructor="constructor"></button>`,
        `<prop name="constructor" type="string" default="safe">Constructor label.</prop>`,
      ),
      "constructor-prop.html",
    );
    const propName: string = "constructor";
    assert.equal(definition.contract.props[propName]?.default, "safe");
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

  it("rejects property bindings to non-native properties and non-attribute prop types", () => {
    // A property binding may only reach a native DOM property; component inputs are attributes.
    expectDiagnostic(
      "HP001",
      componentSource(`<div .anchorRect="anchor"></div>`, `<prop name="anchor" type="string">Anchor id.</prop>`),
    );
    expectDiagnostic(
      "HC017",
      componentSource(`<div :data-anchor="anchor"></div>`, `<prop name="anchor" type="unknown">Anchor geometry.</prop>`),
    );
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

  it("rejects undeclared expressions", () => {
    expectDiagnostic("HT003", componentSource(`<button :title="missing"></button>`));
  });

  it("targets a prop's first binding and lets it bind in more places", () => {
    const definition = parseComponent(
      componentSource(
        `<button :title="label" :aria-label="label"><span $value="label"></span></button>`,
        `<prop name="label" type="string">Label.</prop>`,
      ),
      "label.html",
    );
    assert.deepEqual(definition.contract.props.label?.target, { attribute: "title" });
    assert.deepEqual(definition.template.attributes.map((attribute) => attribute.name), ["title", "aria-label"]);
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

  it("preserves native forms as component markup without creating component declarations", () => {
    const definition = parseComponent(
      `<template component="x-editor" status="early" summary="Editor.">` +
        `<defs><state name="draft" :value="{ title: 'Draft' }"></state></defs>` +
        `<form name="editor" method="post" action="/api/posts/42">` +
        `<input name="title" bind:value="draft.title"><button>Save</button></form></template>`,
    );
    assert.deepEqual(definition.declarations?.map((declaration) => declaration.kind), ["state"]);
    assert.equal(definition.template.name, "form");
    assert.deepEqual(
      definition.template.attributes
        .filter((attribute) => attribute.kind === "literal")
        .map((attribute) => [attribute.name, attribute.value]),
      [["name", "editor"], ["method", "post"], ["action", "/api/posts/42"]],
    );
  });

  it("normalizes the complete declaration and template language into one IR", () => {
    const definition = parseComponent(
      `<template component="x-results" status="experimental" summary="Search results." controller="./results.js">` +
        `<defs>` +
        `<prop name="query" type="string" required>Search query.</prop>` +
        `<state name="form" :value="{ selected: 0 }"></state>` +
        `<computed name="hasQuery" from="query != ''"></computed>` +
        `<data name="results" src="/api/search" type="object" debounce="150ms" poll="30s">` +
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
        debounce: data.debounce,
        poll: data.poll,
        parameters: data.parameters.map((parameter) => ({
          name: parameter.name,
          dependencies: parameter.expression.dependencies,
        })),
      },
      {
        source: "/api/search",
        type: "object",
        debounce: "150ms",
        poll: "30s",
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
    // The spec's polymorphic root: an ordinary `as` prop chooses between explicit native roots.
    const button = (root: string, defs = `<prop name="as" type="button | a" default="button">Root.</prop>`) =>
      `<template component="x-button" status="early" summary="Polymorphic."><defs>${defs}</defs>${root}</template>`;
    const polymorphic = parseComponent(button(
      `<template $match><a $when="as = 'a'" $ref="control"><slot name="icon"></slot><slot></slot></a>` +
        `<button $else type="button" $ref="control"><slot name="icon"></slot><slot></slot></button></template>`,
    ));
    assert.deepEqual(polymorphic.root, { kind: "native", element: "button", choices: ["a", "button"] });
    assert.equal(polymorphic.contract.nativeElement, "button");
    // Each arm declares the same slots; the contract lists each once.
    assert.deepEqual(polymorphic.slots, [{ name: "icon", dynamic: false, required: true }, { dynamic: false, required: true }]);
    // `as` does not retag an element.
    expectDiagnostic("HT021", componentSource(`<button as="button|a"></button>`));
    // Exactly one native root is always chosen.
    expectDiagnostic("HT021", button(`<template $match><a $when="as = 'a'"></a><button $when="as = 'button'"></button></template>`));
    expectDiagnostic("HT021", button(`<template $match><template $when="as = 'a'"><a></a></template><button $else></button></template>`));
    expectDiagnostic("HT021", button(`<template $match="as"><a $when="as = 'a'"></a><button $else></button></template>`));
    // Arms read props, state, and computed values, like any expression.
    assert.deepEqual(parseComponent(button(
      `<template $match><details $when="open"></details><a $when="linked"></a><button $else></button></template>`,
      `<prop name="as" type="button | a" default="button">Root.</prop><state name="open" :value="false"></state>` +
        `<computed name="linked" from="as = 'a'"></computed>`,
    )).root, { kind: "native", element: "button", choices: ["details", "a", "button"] });
    // A slot is still declared once within an arm.
    expectDiagnostic("HT008", button(`<template $match><a $when="as = 'a'"><slot></slot><slot></slot></a><button $else></button></template>`));

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

  it("applies the shared executable URL policy to every URL attribute", () => {
    for (const attribute of ["action", "data", "formaction", "href", "poster", "src", "xlink:href"]) {
      for (const value of ["javascript:alert(1)", "data:text/html,bad", "vbscript:bad", "java\nscript:bad"]) {
        assert.throws(
          () => validateLiteralAttributeName(attribute, "component.html", value),
          (error: unknown) =>
            error instanceof HtmlDiagnosticError && error.diagnostic.code === "HT007",
        );
      }
    }
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

  it("rejects a <data> time value or declared type it cannot read", () => {
    const source = (attributes: string) =>
      `<template component="x-d" status="early" summary="Data diagnostics.">` +
      `<defs><data name="feed" src="/api/feed" ${attributes}></data></defs><output></output></template>`;
    for (const attributes of ['debounce="soon"', 'poll="2 minutes"', 'type="list("']) {
      assert.throws(() => parseComponent(source(attributes)), /HC024/);
    }
    // Time values with units and bare milliseconds are both readable.
    for (const attributes of ['debounce="200ms"', 'poll="30s"', 'debounce="150"', 'type="object"']) {
      assert.doesNotThrow(() => parseComponent(source(attributes)));
    }
  });


  it("reads a quoted enum member that spells a built-in type name", () => {
    // Bare `unknown` is the type that accepts any value, so a literal of that spelling is quoted.
    // The default stays a plain attribute value: quoting belongs to the type expression.
    const definition = parseComponent(
      `<template component="x-state" status="early" summary="Reserved enum.">` +
      `<defs><prop name="status" type="'unknown' | known" default="unknown">Status.</prop></defs>` +
      `<output :data-status="status"></output></template>`,
    );
    const prop = definition.contract.props.status!;
    assert.deepEqual(prop.type, { enum: ["unknown", "known"] });
    const type = normalizeType(prop.type);
    assert.deepEqual(
      ["unknown", "known", "other", 42].map((value) => parseTypedValue(value, type).ok),
      [true, true, false, false],
    );

    // Writing the member bare reads `unknown` as the type, which a prop cannot carry: it has no
    // attribute text form. The mistake is a diagnostic rather than a union that accepts anything.
    assert.throws(
      () => parseComponent(
        `<template component="x-wide" status="early" summary="Wide.">` +
        `<defs><prop name="status" type="unknown | known" default="unknown">Status.</prop></defs>` +
        `<output :data-status="status"></output></template>`,
      ),
      /HC017/,
    );
  });

});
