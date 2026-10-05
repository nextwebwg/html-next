import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";

import { HtmlDiagnosticError } from "../src/diagnostics.js";
import { validateLiteralAttributeName } from "../src/language.js";
import { parseComponent } from "../src/source-parser.js";
import { formatType, normalizeType, parseTypeExpression, parseTypedValue, typeScriptType } from "../src/type-system.js";

const fixtureUrl = new URL("./fixtures/x-button.html", import.meta.url);

describe("component-owned application metadata", () => {
  it("ignores direct carrier metadata without binding it or changing the markup, declarations, or styles", () => {
    const source = '<template component="page-products"><defs><prop name="label" type="string">Label</prop></defs>' +
      '<section $value="label"></section><style>:host { color: red; }</style></template>';
    const metadata = '<meta name="example:layout" content="admin"><title $value="missing">Ignored title</title>' +
      '<meta name="description" from:content="missing"><link rel="stylesheet" href="./ignored.css">';
    const expected = parseComponent(source, "products.html");
    for (const position of ['<defs>', '<section ', '<style>', '</template>']) {
      const actual = parseComponent(source.replace(position, metadata + position), "products.html");
      assert.deepEqual(actual, expected);
    }
  });

  it("keeps the one-root rule and rejects active metadata or metadata inside rendered markup", () => {
    for (const content of [
      '<title>Only metadata</title>',
      '<meta http-equiv="refresh" content="0"><section></section>',
      '<meta name="description" onload="run()"><section></section>',
      '<link rel="import" href="./other.html"><section></section>',
      '<link rel="component" href="./other.html"><section></section>',
      '<script>run()</script><section></section>',
      '<section><meta name="description" content="Nested"></section>',
      '<title>Metadata</title><section></section><article></article>',
    ]) assert.throws(() => parseComponent(`<template component="page-invalid">${content}</template>`), HtmlDiagnosticError);
  });
});

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

describe("full text expressions", () => {
  it("matches nested objects and quoted braces, preserves escapes, and checks expression scope", () => {
    const definition = parseComponent(String.raw`<template component="x-text-expr"><defs><state name="amount" type="number" value="12"></state></defs><p>Total: {format($amount, 'currency', { currency: 'USD' }, 'en')} / {concat('}', '{')} / \{literal} / $amount / \$amount / \\</p></template>`);
    const text = definition.template.children[0]!;
    assert.equal(text.kind, "text");
    if (text.kind !== "text") return;
    assert.deepEqual(text.segments?.filter((segment) => segment.expressionPlan !== undefined).map((segment) => segment.expressionPlan?.dependencies), [["amount"], []]);
    assert.equal(text.segments?.at(-1)?.value, " / {literal} / $amount / \\$amount / \\");
    for (const value of ["{", "{}", "{ }", "{$missing}", "{1 +}", "{format(}"]) {
      assert.throws(() => parseComponent(`<template component="x-bad-text"><p>${value}</p></template>`), HtmlDiagnosticError);
    }
  });
  it("leaves dollar paths and punctuation literal outside braces, without scope checks", () => {
    const definition = parseComponent(String.raw`<template component="x-text"><p>$unknown.name.txt $HOME $1.15 \$ident</p></template>`);
    assert.deepEqual(definition.template.children, [{ kind: "text", value: String.raw`$unknown.name.txt $HOME $1.15 \$ident` }]);
  });
});

describe("parseComponent", () => {
  it("shares identifier rules across declarations, loops, and aliases", () => {
    assert.doesNotThrow(() => parseComponent(`<template component="x-names"><defs>
      <state name="_name" type="string" value="Ada"></state>
      <state name="Name" type="string" value="Bea"></state>
      <state name="name" type="string" value="Lin"></state>
      <state name="café" type="number" value="1"></state>
      </defs><p>{$_name} / {$Name} / {$name} / {$café}</p></template>`));
    for (const name of ["$name", "name$tail", "first-name", "-name", "--name", "1name"]) {
      expectDiagnostic("HC013", `<template component="x-names"><defs><state name="${name}" value="1"></state></defs><p></p></template>`);
      expectDiagnostic("HT016", `<template component="x-names"><p $each="${name} of [1]">Hi</p></template>`);
      expectDiagnostic("HT015", `<template component="x-names"><p $with="1 as ${name}">Hi</p></template>`);
    }
    expectDiagnostic("HC011", `<template component="x-names"><defs>
      <prop name="Name" type="string">Name.</prop><prop name="name" type="string">Name.</prop>
      </defs><p from:title="Name">$name</p></template>`);
    expectDiagnostic("HT016", `<template component="x-names"><p $each="😀of [1]">Hi</p></template>`);
  });

  it("parses braced inline paths with literals, punctuation, and loop scope", () => {
    const definition = parseComponent(String.raw`<template component="x-text"><defs>
      <state name="rows" type="list(object({ id: number, name: string }))" value="[{ id: 1, name: 'Ada' }]"></state>
      </defs><table><tbody><tr $each="r of $rows" $key="$r.id"><td>Hello {$r.name}. Cost $1.15; $ident; {$rows[0].name}!</td></tr></tbody></table></template>`);
    const cell = definition.template.children[0];
    assert.equal(cell?.kind, "element");
    if (cell?.kind !== "element") return;
    const row = cell.children[0];
    assert.equal(row?.kind, "element");
    if (row?.kind !== "element") return;
    const td = row.children[0];
    assert.equal(td?.kind, "element");
    if (td?.kind !== "element") return;
    assert.deepEqual(td.children.flatMap((child) => child.kind === "text" ? (child.segments ?? [child]).map((segment) => segment.expressionPlan?.dependencies ?? segment.value) : [null]),
      ["Hello ", ["r.name"], ". Cost $1.15; $ident; ", ["rows.0.name"], "!"]);
    expectDiagnostic("HT003", `<template component="x-text"><p>{$unknown}</p></template>`);
  });
  it("reads from: bindings and rejects the former bare-colon spelling", () => {
    const definition = parseComponent(`<template component="x-from"><defs>
      <prop name="label" type="string">Label.</prop>
      <state type="number" name="count" value="0"></state>
    </defs><output from:aria-label="$label" from:data-count="$count"></output></template>`);
    assert.deepEqual(definition.template.attributes.filter((entry) => entry.kind === "attribute").map((entry) => entry.name), ["aria-label", "data-count"]);
    assert.deepEqual(definition.template.attributes.filter((entry) => entry.kind === "attribute").map((entry) => entry.expressionPlan?.dependencies), [["label"], ["count"]]);
    expectDiagnostic("HT010", `<template component="x-old"><defs><prop name="label" type="string">Label.</prop></defs><output :aria-label="label"></output></template>`);
  });

  it("accepts bracketed numeric indexes in authored expressions", () => {
    const definition = parseComponent(`<template component="x-index"><defs>
      <state name="items" type="list(string)" value="['Ada']"></state>
    </defs><output $value="$items[0]"></output></template>`);
    assert.deepEqual(definition.template.attributes.find((entry) => entry.kind === "directive")
      ?.expressionPlan?.dependencies, ["items.0"]);
  });

  it("accepts dimensional scaling and rejects incompatible literal arithmetic", () => {
    assert.doesNotThrow(() => parseComponent(`<template component="x-scale"><defs>
      <state name="width" type="length" value="100px"></state>
      <computed name="half" from="$width / 2"></computed>
    </defs><output $value="half"></output></template>`));
    for (const expression of ["1px + 1", "1px + 1ms", "1px + 1rem", "1px * 1px", "1px / 1px", "1px / 0", "1 / 1px", "1px % 1px"]) {
      expectDiagnostic("HT013", `<template component="x-bad-scale"><output $value="${expression}"></output></template>`);
    }
  });

  it("reports built-in calls whose literal arguments cannot work", () => {
    for (const expression of [
      "concat()", "join(['a'], 1)", "round(8.8px, 1rem)",
      "min(1in, 100px)", "round(8px, 0px)", "default('x', 1)", "join([1, 'two'], ', ')",
    ]) {
      expectDiagnostic("HT013", `<template component="x-invalid-call"><defs>
        <computed name="result" from="${expression.replaceAll('"', '&quot;')}"></computed>
      </defs><output $value="result"></output></template>`);
    }
  });

  it("uses a guaranteed default fallback when checking nested call types", () => {
    const definition = parseComponent(`<template component="x-default-call"><defs>
      <computed name="result" from="round(default(null, 2px))"></computed>
    </defs><output $value="result"></output></template>`);
    assert.equal(definition.contract.tag, "x-default-call");
  });

  it("reads an inline type selected by a prop's permitted values", () => {
    const definition = parseComponent(`<template component="x-inline-type"><defs>
      <prop name="type" type="keyword" values="text, number" default="text">Control mode.</prop>
      <prop name="value">Control value.<type from="type">
        <option value="text" type="string"></option>
        <option value="number" type="number"></option>
      </type></prop>
    </defs><input from:type="type" from:value="value"></template>`);
    assert.deepEqual(definition.contract.props.value?.select, {
      from: "type",
      options: [
        { value: "text", type: { kind: "terminal", name: "string" } },
        { value: "number", type: { kind: "terminal", name: "number" } },
      ],
    });
    assert.equal(normalizeType(definition.contract.props.value!.type).kind, "selected");
  });

  it("resolves a named type under defs to the same selected prop type", () => {
    const definition = parseComponent(`<template component="x-named-type"><defs>
      <type name="input-value" from="type">
        <option value="text" type="string"></option>
        <option value="number" type="number"></option>
      </type>
      <prop name="type" type="keyword" values="text, number" default="text">Control mode.</prop>
      <prop name="value" type="input-value">Control value.</prop>
    </defs><input from:type="type" from:value="value"></template>`);
    assert.deepEqual(definition.contract.props.value?.select, {
      from: "type",
      options: [
        { value: "text", type: { kind: "terminal", name: "string" } },
        { value: "number", type: { kind: "terminal", name: "number" } },
      ],
    });
    assert.equal(normalizeType(definition.contract.props.value!.type).kind, "selected");
  });

  it("resolves a selected type from a declared state by name", () => {
    const definition = parseComponent(`<template component="x-state-type"><defs>
      <state name="mode" type="keyword" values="text, number" value="text"></state>
      <prop name="value">Value.<type from="mode">
        <option value="text" type="string"></option>
        <option value="number" type="number"></option>
      </type></prop>
      <handler name="useNumber"><set name="mode" value="number"></set></handler>
    </defs><output from:data-value="value"></output></template>`);
    assert.deepEqual(definition.contract.props.value?.select, {
      from: "mode",
      options: [
        { value: "text", type: { kind: "terminal", name: "string" } },
        { value: "number", type: { kind: "terminal", name: "number" } },
      ],
    });
    const handler = definition.declarations?.find((declaration) => declaration.kind === "handler");
    assert.equal(handler?.kind, "handler");
    assert.deepEqual(handler.steps[0]?.kind === "set" ? handler.steps[0].value.ast : undefined,
      { kind: "literal", value: "number" });
  });

  it("distinguishes typed constants from action-time expressions", () => {
    const definition = parseComponent(`<template component="x-values"><defs>
      <state name="count" type="number" value="1"></state>
      <event name="saved" type="number"></event>
      <handler name="run">
        <set name="count" value="2"></set>
        <set name="count" expr:value="count + 1"></set>
        <dispatch event="saved" value="3"></dispatch>
        <dispatch event="saved" expr:value="count"></dispatch>
      </handler></defs><button on:click="run"></button></template>`);
    const handler = definition.declarations?.find((declaration) => declaration.kind === "handler");
    assert.equal(handler?.kind, "handler");
    assert.deepEqual(handler.steps.map((step) => (step.kind === "set" || step.kind === "dispatch") ? step.value?.ast : undefined), [
      { kind: "literal", value: 2 },
      { kind: "binary", op: "+", left: { kind: "id", name: "count" }, right: { kind: "literal", value: 1 } },
      { kind: "literal", value: 3 },
      { kind: "id", name: "count" },
    ]);
    expectDiagnostic("HC023", `<template component="x-bad"><defs><state name="count" type="number" value="0"></state><handler name="run"><set name="count" value="abc"></set></handler></defs><button></button></template>`);
  });

  it("marks data parameters as reactive sources or request-time expressions", () => {
    const definition = parseComponent(`<template component="x-request"><defs>
      <state name="query" type="string" value="initial"></state>
      <state name="token" type="string" value="one"></state>
      <data name="result" src="/api/search" type="string">
        <param name="q" from:value="query"></param>
        <param name="token" expr:value="token"></param>
      </data></defs><output $value="result.value"></output></template>`);
    const data = definition.declarations?.find((declaration) => declaration.kind === "data");
    assert.equal(data?.kind, "data");
    assert.deepEqual(data.parameters.map(({ name, mode }) => [name, mode]), [["q", "from"], ["token", "expr"]]);
    expectDiagnostic("HC024", `<template component="x-bad"><defs><data name="result" src="/api/search"><param name="q" from:value="x" expr:value="x"></param></data></defs><output $value="result.value"></output></template>`);
  });

  it("rejects the former expression prefix on setter steps", () => {
    expectDiagnostic("HC023", `<template component="x-counter"><defs><state name="count" type="number" value="0"></state>` +
      `<handler name="increment"><set name="count" from:value="count + 1"></set></handler></defs><button></button></template>`);
  });

  it("rejects a values constraint containing an item outside the declared type", () => {
    expectDiagnostic("HC013", componentSource(
      `<output from:data-size="size"></output>`,
      `<prop name="size" type="keyword" values="sm, two words">Size.</prop>`,
    ));
  });

  it("reads a nested list as the same homogeneous type as list(T)", () => {
    const definition = parseComponent(`<template component="x-table" status="early" summary="Rows.">
      <defs>
        <prop name="rows" type="list">Table rows.
          <prop type="object">
            <prop name="id" type="integer" required></prop>
            <prop name="name" type="string" required></prop>
          </prop>
        </prop>
      </defs>
      <div from:data-rows="rows"></div>
    </template>`);
    const type = normalizeType(definition.contract.props.rows!.type);
    assert.equal(formatType(type), "list(object({ id: integer, name: string }))");
    assert.deepEqual(type, normalizeType(parseTypeExpression("list(object({ id: integer, name: string }))")));
  });

  it("rejects array as a declaration type and lists without one item type", () => {
    expectDiagnostic("HC013", componentSource(`<output from:data-rows="rows"></output>`,
      `<prop name="rows" type="array"><prop type="string"></prop></prop>`));
    expectDiagnostic("HC013", componentSource(`<output from:data-rows="rows"></output>`,
      `<prop name="rows" type="list"></prop>`));
  });

  it("constrains nested event and state fields with their own declared types", () => {
    const definition = parseComponent(`<template component="x-events"><defs>
      <state name="history" type="list" value="[]" nullable>
        <prop type="object">
          <prop name="trigger" type="keyword" values="keyboard, pointer" required></prop>
        </prop>
      </state>
      <event name="change" type="object" open>
        <prop name="value" type="number" required></prop>
        <prop name="previous" type="string" required nullable></prop>
        <prop name="output" type="unknown"></prop>
        <prop name="trigger" type="keyword" values="keyboard, pointer" required></prop>
      </event>
    </defs><output></output></template>`);
    const state = definition.declarations!.find((item) => item.kind === "state");
    const event = definition.declarations!.find((item) => item.kind === "event");
    assert.ok(state?.kind === "state" && state.shape !== undefined);
    assert.ok(event?.kind === "event" && event.shape !== undefined);
    assert.equal(typeScriptType(event.shape), '{ readonly value: number; readonly previous: string | null; readonly output?: unknown; readonly trigger: "keyboard" | "pointer"; readonly [name: string]: unknown }');
    assert.equal(parseTypedValue({ value: 3, previous: null, trigger: "keyboard" }, event.shape).ok, true);
    assert.equal(parseTypedValue({ value: 3, previous: null, output: { arbitrary: true }, extra: 5, trigger: "keyboard" }, event.shape).ok, true);
    assert.equal(parseTypedValue({ value: 3, previous: null, trigger: "touch" }, event.shape).ok, false);
    assert.equal(parseTypedValue({ value: 3, trigger: "keyboard" }, event.shape).ok, false);
    assert.equal(parseTypedValue([{ trigger: "pointer" }], state.shape).ok, true);
    assert.equal(parseTypedValue([{ trigger: "touch" }], state.shape).ok, false);
    assert.equal(parseTypedValue(null, state.shape).ok, true);
  });

  it("keeps a prop's HTML pattern constraint", () => {
    const definition = parseComponent(componentSource(
      `<output from:data-sku="sku"></output>`,
      `<prop name="sku" type="string" pattern="[A-Z]{3}-[0-9]{4}">Product code.</prop>`,
    ));
    assert.equal(definition.contract.props.sku?.pattern, "[A-Z]{3}-[0-9]{4}");
  });

  it("reads numeric, temporal, and text bounds from prop declarations", () => {
    const definition = parseComponent(componentSource(
      `<output from:data-count="count" from:data-date="date" from:data-code="code"></output>`,
      `<prop name="count" type="integer" min="1" max="9" default="3">Count.</prop>
       <prop name="date" type="date" min="2026-01-01" max="2026-12-31">Date.</prop>
       <prop name="code" type="string" minlength="2" maxlength="5">Code.</prop>`,
    ));
    assert.deepEqual([definition.contract.props.count?.min, definition.contract.props.count?.max], [1, 9]);
    assert.deepEqual([definition.contract.props.date?.min, definition.contract.props.date?.max], ["2026-01-01", "2026-12-31"]);
    assert.deepEqual([definition.contract.props.code?.minLength, definition.contract.props.code?.maxLength], [2, 5]);
  });

  it("rejects incompatible or malformed authored bounds and invalid defaults", () => {
    const output = `<output from:data-value="value"></output>`;
    for (const declaration of [
      `<prop name="value" type="string" min="1">Value.</prop>`,
      `<prop name="value" type="number" min="oops">Value.</prop>`,
      `<prop name="value" type="number" maxlength="3">Value.</prop>`,
      `<prop name="value" type="string" minlength="-1">Value.</prop>`,
      `<prop name="value" type="integer" min="2" default="1">Value.</prop>`,
      `<prop name="value" type="string" minlength="3" default="ab">Value.</prop>`,
    ]) expectDiagnostic(declaration.includes("default=") ? "HC015" : "HC013", componentSource(output, declaration));
  });

  it("checks bounds on nested fields", () => {
    const definition = parseComponent(`<template component="x-bounded"><defs>
      <event name="change" type="object">
        <prop name="amount" type="number" min="0" max="100" required></prop>
        <prop name="label" type="string" minlength="2" maxlength="8" required></prop>
      </event>
    </defs><output></output></template>`);
    const event = definition.declarations!.find((item) => item.kind === "event");
    assert.ok(event?.kind === "event" && event.shape !== undefined);
    assert.equal(parseTypedValue({ amount: 20, label: "okay" }, event.shape, "$", "value").ok, true);
    assert.equal(parseTypedValue({ amount: 101, label: "okay" }, event.shape, "$", "value").ok, false);
    assert.equal(parseTypedValue({ amount: 20, label: "x" }, event.shape, "$", "value").ok, false);
  });
  it("normalizes the full component interface and named slot shapes", () => {
    const definition = parseComponent(
      `<template component="ui-combobox" status="early" summary="A composed field." controller="./combobox.js">` +
        `<defs>` +
        `<prop name="config" type="string">Property-only configuration.</prop>` +
        `<state type="string" name="query" value=""></state>` +
        `<computed name="empty" from="not query"></computed>` +
        `<event name="value-change" type="string"></event>` +
        `<method name="validate" returns="string" export="validate"></method>` +
        `</defs>` +
        `<div><slot name="start"><span>Start</span></slot><slot from:name="query"></slot></div>` +
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

  it("parses repeated scoped slots and exposes their row bindings", () => {
    const definition = parseComponent(
      `<template component="x-rows"><defs><prop name="rows" type="list(object({ id: string, name: string }))">Rows.</prop></defs>` +
      `<ul><slot $each="row of rows" $key="row.id" name="row" from:item="row" from:index="loop.index">` +
      `<li $value="row.name"></li></slot></ul></template>`,
    );
    const slot = definition.template.children[0];
    assert.ok(slot?.kind === "slot");
    assert.equal(slot.flow?.kind, "each");
    assert.deepEqual(slot.flow?.kind === "each" && slot.flow.listPlan?.dependencies, ["rows"]);
    assert.deepEqual(slot.flow?.kind === "each" && slot.flow.keyPlan?.dependencies, ["row.id"]);
    assert.deepEqual(slot.props?.map((prop) => [prop.name, prop.expressionPlan.dependencies]), [
      ["item", ["row"]], ["index", ["loop.index"]],
    ]);
    assert.deepEqual(definition.slots, [{ name: "row", dynamic: false, required: false, props: ["item", "index"] }]);
    assert.deepEqual(slot.fallback?.[0]?.kind === "element" && slot.fallback[0].attributes[0]?.kind === "directive"
      && slot.fallback[0].attributes[0].expressionPlan?.dependencies, ["row.name"]);
  });

  it("retains every scoped prop when root alternatives expose the same slot", () => {
    const definition = parseComponent(`<template component="x-alternate-slots"><defs>` +
      `<state name="first" value="First"></state><state name="second" value="Second"></state>` +
      `<state type="boolean" name="alternate" value="false"></state></defs>` +
      `<template $match><section $when="alternate"><slot name="item" from:first="first"></slot></section>` +
      `<article $else><slot name="item" from:second="second"></slot></article></template></template>`);
    assert.deepEqual(definition.slots, [{ name: "item", dynamic: false, required: true, props: ["first", "second"] }]);
  });

  it("defers unknown names only inside a consumer's scoped-slot template", () => {
    const definition = parseComponent(`<template component="x-consumer"><defs><state name="heading" value="People"></state></defs>` +
      `<section><x-row-list><template slot="row"><b $value="item.name"></b><i $value="heading"></i></template></x-row-list></section></template>`);
    const invocation = definition.template.children[0];
    assert.ok(invocation?.kind === "element");
    const projection = invocation.children[0];
    assert.ok(projection?.kind === "element" && projection.name === "template");
    assert.equal(projection.children[0]?.kind === "element" && projection.children[0].attributes[0]?.kind === "directive" &&
      projection.children[0].attributes[0].expressionPlan?.dependencies[0], "item.name");
    expectDiagnostic("HT003", `<template component="x-invalid"><section><b $value="item.name"></b></section></template>`);
  });

  it("treats status and summary as optional", () => {
    const definition = parseComponent('<template component="x-plain"><div></div></template>', "plain.html");
    assert.equal(definition.contract.status, undefined);
    assert.equal(definition.contract.summary, undefined);
  });

  it("accepts prop names that exist on Object.prototype", () => {
    const definition = parseComponent(
      componentSource(
        `<button from:data-constructor="constructor"></button>`,
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
        `<button from:data-value="value"></button></template>`,
    );
  });

  it("parses ancestor state and aliased read-only context", () => {
    const provider = parseComponent(
      `<template component="x-steps"><defs><state type="number" name="current" value="1"></state></defs>` +
        `<ol><slot></slot></ol></template>`,
    );
    const reader = parseComponent(
      `<template component="x-step"><defs><context name="current" from="x-steps" as="activeStep"></context></defs>` +
        `<li from:aria-current="activeStep = 1 ? 'step' : null"></li></template>`,
    );
    assert.equal(provider.declarations?.[0]?.kind, "state");
    assert.equal(provider.declarations?.[0]?.name, "current");
    assert.deepEqual(reader.declarations?.[0], {
      kind: "context",
      name: "current",
 from: "x-steps",
      as: "activeStep",
    });
    assert.deepEqual(reader.template.attributes[0]?.kind, "attribute");
  });

  it("requires a context source and keeps context reads out of writable paths", () => {
    expectDiagnostic("HC013", `<template component="x-steps"><defs><state name="current" context></state></defs><ol></ol></template>`);
    expectDiagnostic("HC013", `<template component="x-step"><defs><context name="current"></context></defs><li></li></template>`);
    expectDiagnostic("HC020", `<template component="x-step"><defs><state name="active"></state>` +
      `<context name="current" from="x-steps" as="active"></context></defs><li></li></template>`);
    expectDiagnostic("HT005", `<template component="x-step"><defs>` +
      `<context name="current" from="x-steps"></context></defs><li><input bind:value="current"></li></template>`);
  });

  it("keeps external event names separate from value bindings", () => {
    const definition = parseComponent(
      `<template component="demo-example" status="early" summary="Event namespace.">` +
        `<defs><prop name="open" type="boolean" default="false">Open.</prop>` +
        `<event name="open" type="boolean"></event></defs>` +
        `<button from:data-open="open"></button></template>`,
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

  it("rejects property bindings to non-native properties and property-only prop types", () => {
    // A property binding may only reach a native DOM property; component inputs are attributes.
    expectDiagnostic(
      "HP001",
      componentSource(`<div .anchorRect="anchor"></div>`, `<prop name="anchor" type="string">Anchor id.</prop>`),
    );
    expectDiagnostic(
      "HC017",
      componentSource(`<div from:data-anchor="anchor"></div>`, `<prop name="anchor" type="unknown">Anchor geometry.</prop>`),
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
    expectDiagnostic("HT003", componentSource(`<button from:title="missing"></button>`));
  });

  it("targets a prop's first binding and lets it bind in more places", () => {
    const definition = parseComponent(
      componentSource(
        `<button from:title="label" from:aria-label="label"><span $value="label"></span></button>`,
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
      componentSource(`<button from:data-x="v"></button>`, `<prop type="string">No name.</prop>`),
    );
    expectDiagnostic(
      "HC013",
      componentSource(`<button from:data-x="v"></button>`, `<prop name="v">No type.</prop>`),
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
        `<defs><state type="object({ email: string })" name="form" value="{ email: '' }"></state>` +
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
        `<defs><state type="object({ title: string })" name="draft" value="{ title: 'Draft' }"></state></defs>` +
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
        `<state type="object({ selected: number })" name="form" value="{ selected: 0 }"></state>` +
        `<computed name="hasQuery" from="query != ''"></computed>` +
        `<data name="results" src="/api/search" type="object" debounce="150ms" poll="30s">` +
        `<param name="q" from:value="query"></param></data>` +
        `<event name="selection-change" type="number" bubbles="false" composed="false" cancelable="true"></event>` +
        `<method name="refresh" export="refresh" returns="promise(undefined)"></method>` +
        `<handler name="select">` +
        `<set name="form.selected" expr:value="form.selected + 1" $if="hasQuery"></set>` +
        `<validate target="search"></validate><focus ref="search"></focus>` +
        `<dispatch event="selection-change" expr:value="form.selected"></dispatch>` +
        `</handler></defs>` +
        `<section from:data-ready="hasQuery" class:active="hasQuery" style:opacity="hasQuery" $ref="root">` +
        `<input .value="query" bind:data-index="form.selected" $ref="search" on:input.capture.once="select">` +
        `<ol><li $each="row, i of results.value" $where="row.visible" $sort="-score,name" $limit="3" $key="row.id">` +
        `<slot from:name="row.id"><span $value="i"></span></slot></li></ol>` +
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
    const button = (root: string, defs = `<prop name="as" type="keyword" values="button, a" default="button">Root.</prop>`) =>
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
      `<prop name="as" type="keyword" values="button, a" default="button">Root.</prop><state type="boolean" name="open" value="false"></state>` +
        `<computed name="linked" from="as = 'a'"></computed>`,
    )).root, { kind: "native", element: "button", choices: ["details", "a", "button"] });
    // A slot required by any arm is required; arms' dynamic slots merge by position.
    const merged = parseComponent(button(
      `<template $match><a $when="as = 'a'"><slot name="icon"></slot><slot from:name="as"></slot></a>` +
        `<button $else><slot name="icon">★</slot><slot from:name="as">fallback</slot></button></template>`,
    ));
    assert.deepEqual(merged.slots, [{ name: "icon", dynamic: false, required: true }, { dynamic: true, required: true }]);
    // A slot is not a native root.
    expectDiagnostic("HT021", button(`<template $match><slot></slot><button $else></button></template>`));
    // A slot is still declared once within an arm.
    expectDiagnostic("HT008", button(`<template $match><a $when="as = 'a'"><slot></slot><slot></slot></a><button $else></button></template>`));

    const delegated = parseComponent(
      `<template component="x-primary" status="early" summary="Delegates.">` +
        `<x-base-button><slot></slot></x-base-button></template>`,
    );
    assert.deepEqual(delegated.root, { kind: "component", tag: "x-base-button" });
  });

  it("rejects root directives that can produce zero or multiple elements", () => {
    expectDiagnostic("HT021", componentSource(`<button $if="false"></button>`));
    expectDiagnostic("HT021", componentSource(`<button $each="item of []"></button>`));
    expectDiagnostic("HT021", componentSource(`<button $when="true"></button>`));
    expectDiagnostic("HT021", componentSource(`<button $else></button>`));
    expectDiagnostic("HT021", componentSource(`<template $with="1 as item"><button></button></template>`));
    expectDiagnostic("HT021", componentSource(`<slot></slot>`));
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

  it("rejects deferred declarative connection lifecycle bindings", () => {
    const declarations = `<defs><state type="boolean" name="ready" value="false"></state>` +
      `<handler name="markReady"><set name="ready" value="true"></set></handler></defs>`;
    for (const attribute of ["on:connect", "on:disconnect"]) {
      expectDiagnostic("HT010", `<template component="demo-example">${declarations}<section ${attribute}="markReady"></section></template>`);
      expectDiagnostic("HT010", `<template component="demo-example">${declarations}<section><span ${attribute}="markReady"></span></section></template>`);
    }
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


  it("reads permitted values that spell type names", () => {
    const definition = parseComponent(
      `<template component="x-state" status="early" summary="Reserved enum.">` +
      `<defs><prop name="status" type="keyword" values="unknown, known" default="unknown">Status.</prop></defs>` +
      `<output from:data-status="status"></output></template>`,
    );
    const prop = definition.contract.props.status!;
    assert.deepEqual(prop.type, { kind: "terminal", name: "keyword" });
    assert.deepEqual(prop.values, ["unknown", "known"]);
    const type = normalizeType(prop.type);
    assert.deepEqual(["unknown", "known", "other", 42].map((value) =>
      parseTypedValue(value, type).ok && prop.values?.includes(value as string)), [true, true, false, false]);

    // The old bare keyword syntax is no longer a declaration.
    assert.throws(
      () => parseComponent(
        `<template component="x-wide" status="early" summary="Wide.">` +
        `<defs><prop name="status" type="unknown | known" default="unknown">Status.</prop></defs>` +
        `<output from:data-status="status"></output></template>`,
      ),
      /HC013/,
    );
  });

});


describe("handler event references", () => {
  it("reserves $$event for handler expressions and guards", () => {
    const definition = parseComponent(`<template component="x-event"><defs>
      <event name="activate" type="unknown"></event>
      <handler name="activate"><dispatch event="activate" expr:value="$$event" $if="$$event.type = 'click'"></dispatch></handler>
      </defs><button on:click="activate"></button></template>`);
    const handler = definition.declarations?.find((entry) => entry.kind === "handler");
    assert.equal(handler?.kind, "handler");
    if (handler?.kind !== "handler") return;
    assert.deepEqual(handler.steps[0]?.guard?.dependencies, ["$$event.type"]);
    for (const markup of [
      '<p $value="$$event.type"></p>',
      '<defs><computed name="source" from="$$event"></computed></defs><p></p>',
    ]) assert.throws(() => parseComponent(`<template component="x-invalid-event">${markup}</template>`), HtmlDiagnosticError);
  });
});
