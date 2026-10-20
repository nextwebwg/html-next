import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";

import { JSDOM, VirtualConsole } from "jsdom";

import { parseBrowserComponent } from "../src/browser-source.js";
import { HtmlDiagnosticError } from "../src/diagnostics.js";
import { validateLiteralAttributeName } from "../src/language.js";
import { parseComponent } from "../src/source-parser.js";
import type { ElementNode } from "../src/template.js";
import { formatType, normalizeType, parseTypeExpression, parseTypedValue, typeScriptType } from "../src/type-system.js";

const fixtureUrl = new URL("./fixtures/x-button.html", import.meta.url);

describe("head content outside <defs>", () => {
  it("rejects a head element placed directly in a carrier", () => {
    const source = '<template component="page-products"><defs><prop name="label" type="string">Label</prop></defs>' +
      '<section $value="$label"></section><style>:host { color: red; }</style></template>';
    for (const element of ['<meta name="example:layout" content="admin">', "<title>Products</title>",
      '<meta name="description" content="Products">', '<link rel="canonical" href="/products/">']) {
      for (const position of ["<defs>", "<section ", "<style>", "</template>"]) {
        assert.throws(() => parseComponent(source.replace(position, element + position), "products.html"),
          (error: unknown) => error instanceof HtmlDiagnosticError && error.diagnostic.code === "HS002", `${element} before ${position}`);
      }
    }
  });

  it("rejects active metadata and metadata inside rendered markup", () => {
    for (const content of [
      '<meta http-equiv="refresh" content="0"><section></section>',
      '<meta name="description" onload="run()"><section></section>',
      '<link rel="import" href="./other.html"><section></section>',
      '<link rel="component" href="./other.html"><section></section>',
      '<script>run()</script><section></section>',
      '<section><meta name="description" content="Nested"></section>',
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
      </defs><p from:title="$Name">$name</p></template>`);
    expectDiagnostic("HT016", `<template component="x-names"><p $each="😀of [1]">Hi</p></template>`);
  });

  it("scopes $each, $with, and $match names to their own subtree", () => {
    const source = (body: string) => `<template component="x-scope"><defs>
      <state name="account" type="object({ owner: string, plan: string })" value="{ owner: 'Ada', plan: 'pro' }"></state>
      <state name="rows" type="list(string)" value="[]"></state></defs><section>${body}</section></template>`;
    const scoped = `<div $with="$account.owner as owner"><p>{$owner}</p></div>` +
      `<template $match="$account.plan as plan"><b $when="$plan = 'pro'">{$plan}</b><i $else>{$plan}</i></template>` +
      `<ul><li $each="row, i of $rows">{$row} {$i} {$loop.index}</li></ul>`;
    assert.doesNotThrow(() => parseComponent(source(scoped)));
    for (const outside of ["$owner", "$plan", "$row", "$i", "$loop.index"]) {
      expectDiagnostic("HT003", source(`${scoped}<p>{${outside}}</p>`));
      expectDiagnostic("HT003", source(`<p from:title="${outside}">${scoped}</p>`));
    }
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
    </defs><output $value="$half"></output></template>`));
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
      </defs><output $value="$result"></output></template>`);
    }
  });

  it("uses a guaranteed default fallback when checking nested call types", () => {
    const definition = parseComponent(`<template component="x-default-call"><defs>
      <computed name="result" from="round(default(null, 2px))"></computed>
    </defs><output $value="$result"></output></template>`);
    assert.equal(definition.contract.tag, "x-default-call");
  });

  it("reads an inline type selected by a prop's permitted values", () => {
    const definition = parseComponent(`<template component="x-inline-type"><defs>
      <prop name="type" type="keyword" values="text, number" default="text">Control mode.</prop>
      <prop name="value">Control value.<type from="type">
        <option value="text" type="string"></option>
        <option value="number" type="number"></option>
      </type></prop>
    </defs><input from:type="$type" from:value="$value"></template>`);
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
    </defs><input from:type="$type" from:value="$value"></template>`);
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
    </defs><output from:data-value="$value"></output></template>`);
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
        <set name="count" expr:value="$count + 1"></set>
        <dispatch event="saved" value="3"></dispatch>
        <dispatch event="saved" expr:value="$count"></dispatch>
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
        <param name="q" from:value="$query"></param>
        <param name="token" expr:value="$token"></param>
      </data></defs><output $value="$result.value"></output></template>`);
    const data = definition.declarations?.find((declaration) => declaration.kind === "data");
    assert.equal(data?.kind, "data");
    assert.deepEqual(data.parameters.map(({ name, mode }) => [name, mode]), [["q", "from"], ["token", "expr"]]);
    expectDiagnostic("HC024", `<template component="x-bad"><defs><data name="result" src="/api/search"><param name="q" from:value="$x" expr:value="$x"></param></data></defs><output $value="$result.value"></output></template>`);
  });

  it("rejects the former expression prefix on setter steps", () => {
    expectDiagnostic("HC023", `<template component="x-counter"><defs><state name="count" type="number" value="0"></state>` +
      `<handler name="increment"><set name="count" from:value="$count + 1"></set></handler></defs><button></button></template>`);
  });

  it("rejects a values constraint containing an item outside the declared type", () => {
    expectDiagnostic("HC013", componentSource(
      `<output from:data-size="$size"></output>`,
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
      <div from:data-rows="$rows"></div>
    </template>`);
    const type = normalizeType(definition.contract.props.rows!.type);
    assert.equal(formatType(type), "list(object({ id: integer, name: string }))");
    assert.deepEqual(type, normalizeType(parseTypeExpression("list(object({ id: integer, name: string }))")));
  });

  it("rejects array as a declaration type and lists without one item type", () => {
    expectDiagnostic("HC013", componentSource(`<output from:data-rows="$rows"></output>`,
      `<prop name="rows" type="array"><prop type="string"></prop></prop>`));
    expectDiagnostic("HC013", componentSource(`<output from:data-rows="$rows"></output>`,
      `<prop name="rows" type="list"></prop>`));
  });

  it("constrains nested event and state fields with their own declared types", () => {
    const definition = parseComponent(`<template component="x-events"><defs>
      <state name="history" type="list" value="[]">
        <prop type="object">
          <prop name="trigger" type="keyword" values="keyboard, pointer" required></prop>
        </prop>
      </state>
      <event name="change" type="object" open>
        <prop name="value" type="number" required></prop>
        <prop name="previous" type="string"></prop>
        <prop name="output" type="unknown"></prop>
        <prop name="trigger" type="keyword" values="keyboard, pointer" required></prop>
      </event>
    </defs><output></output></template>`);
    const state = definition.declarations!.find((item) => item.kind === "state");
    const event = definition.declarations!.find((item) => item.kind === "event");
    assert.ok(state?.kind === "state" && state.shape !== undefined);
    assert.ok(event?.kind === "event" && event.shape !== undefined);
    assert.equal(typeScriptType(event.shape), '{ readonly value: number; readonly previous?: string | null; readonly output?: unknown | null; readonly trigger: "keyboard" | "pointer"; readonly [name: string]: unknown }');
    assert.equal(parseTypedValue({ value: 3, previous: null, trigger: "keyboard" }, event.shape).ok, true);
    assert.equal(parseTypedValue({ value: 3, previous: null, output: { arbitrary: true }, extra: 5, trigger: "keyboard" }, event.shape).ok, true);
    assert.equal(parseTypedValue({ value: 3, previous: null, trigger: "touch" }, event.shape).ok, false);
    // A null field is a missing one.
    assert.equal(parseTypedValue({ value: 3, trigger: "keyboard" }, event.shape).ok, true);
    assert.equal(parseTypedValue({ value: null, trigger: "keyboard" }, event.shape).ok, false);
    assert.equal(parseTypedValue([{ trigger: "pointer" }], state.shape).ok, true);
    assert.equal(parseTypedValue([{ trigger: "touch" }], state.shape).ok, false);
  });

  it("reports nullable as a declaration attribute to remove", () => {
    for (const declaration of ['<prop name="label" type="string" nullable></prop>', '<state name="level" type="integer" nullable></state>']) {
      expectDiagnostic("HC013", `<template component="x-nullable"><defs>${declaration}</defs><output></output></template>`);
    }
  });

  it("keeps a prop's HTML pattern constraint", () => {
    const definition = parseComponent(componentSource(
      `<output from:data-sku="$sku"></output>`,
      `<prop name="sku" type="string" pattern="[A-Z]{3}-[0-9]{4}">Product code.</prop>`,
    ));
    assert.equal(definition.contract.props.sku?.pattern, "[A-Z]{3}-[0-9]{4}");
  });

  it("reads numeric, temporal, and text bounds from prop declarations", () => {
    const definition = parseComponent(componentSource(
      `<output from:data-count="$count" from:data-date="$date" from:data-code="$code"></output>`,
      `<prop name="count" type="integer" min="1" max="9" default="3">Count.</prop>
       <prop name="date" type="date" min="2026-01-01" max="2026-12-31">Date.</prop>
       <prop name="code" type="string" minlength="2" maxlength="5">Code.</prop>`,
    ));
    assert.deepEqual([definition.contract.props.count?.min, definition.contract.props.count?.max], [1, 9]);
    assert.deepEqual([definition.contract.props.date?.min, definition.contract.props.date?.max], ["2026-01-01", "2026-12-31"]);
    assert.deepEqual([definition.contract.props.code?.minLength, definition.contract.props.code?.maxLength], [2, 5]);
  });

  it("rejects incompatible or malformed authored bounds and invalid defaults", () => {
    const output = `<output from:data-value="$value"></output>`;
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
  it("rejects unsupported method declarations", () => {
    expectDiagnostic("HC021", `<template component="x-method"><defs><method name="validate"></method></defs><div></div></template>`);
  });

  it("normalizes the full component interface and named slot shapes", () => {
    const definition = parseComponent(
      `<template component="ui-combobox" status="early" summary="A composed field." controller="./combobox.js">` +
        `<defs>` +
        `<prop name="config" type="string">Property-only configuration.</prop>` +
        `<state type="string" name="query" value=""></state>` +
        `<computed name="empty" from="not $query"></computed>` +
        `<event name="value-change" type="string"></event>` +
        `</defs>` +
        `<div><slot name="start"><span>Start</span></slot><slot></slot></div>` +
        `</template>`,
      "combobox.html",
    );

    assert.equal(definition.controller, "./combobox.js");
    assert.deepEqual(definition.declarations!.map(({ kind, name }) => [kind, name]), [
      ["state", "query"],
      ["computed", "empty"],
      ["event", "value-change"],
    ]);
    const state = definition.declarations![0];
    const computed = definition.declarations![1];
    assert.ok(state?.kind === "state");
    assert.ok(computed?.kind === "computed");
    assert.deepEqual(state.expression?.dependencies, []);
    assert.deepEqual(computed.expression?.dependencies, ["query"]);
    assert.deepEqual(definition.slots!.map(({ name, required }) => ({ name, required })), [
      { name: "start", required: false },
      { name: undefined, required: true },
    ]);
    assert.ok(Object.isFrozen(definition));
    assert.ok(Object.isFrozen(definition.contract));
    assert.ok(Object.isFrozen(definition.contract.props));
  });

  it("names slots with literal identifiers on outlets and consumers alike", () => {
    const card = (markup: string): string => `<template component="x-card" status="early" summary="Card.">${markup}</template>`;
    const message = (source: string): string => {
      try { parseComponent(source, "component.html"); } catch (error) { if (error instanceof HtmlDiagnosticError) return error.diagnostic.message; }
      return "";
    };
    // An outlet's name is written, never computed; the diagnostic points to a scoped slot that passes the item.
    assert.match(message(card(`<defs><state name="rows" type="list(object({ id: string }))" value="[]"></state></defs>` +
      `<ul><li $each="row of $rows"><slot from:name="concat('option-', $row.id)"></slot></li></ul>`)),
      /never computed with `from:name`.*one named scoped slot that passes the item as a prop/);
    // A slot name is an expression-scope identifier: no `-`.
    assert.match(message(card(`<div><slot name="label-action"></slot></div>`)), /`label-action` is not an identifier.*such as `labelAction`/);
    assert.deepEqual(parseComponent(card(`<div><slot name="labelAction"></slot><slot name="_end2"></slot></div>`)).slots?.map((slot) => slot.name), ["labelAction", "_end2"]);
    // A consumer names the slot it fills the same way, on an element or a <template slot>.
    const page = (children: string): string => `<template component="x-page" status="early" summary="Page."><main><x-card>${children}</x-card></main></template>`;
    expectDiagnostic("HT008", page(`<b slot="label-action">A</b>`));
    expectDiagnostic("HT008", page(`<b slot="$which">A</b>`));
    expectDiagnostic("HT008", page(`<template slot="row-a"><b>A</b></template>`));
    assert.match(message(page(`<b from:slot="'title'">A</b>`)), /cannot be bound with `from:slot`/);
    // An empty `slot` assigns the default slot, and a plain element outside a component keeps its native `slot`.
    parseComponent(page(`<b slot="">A</b><b slot="labelAction">B</b>`));
    parseComponent(`<template component="x-plain" status="early" summary="Plain."><div><b slot="header-actions">A</b></div></template>`);
  });

  it("declares a slot's props in <defs> and checks each outlet against them", () => {
    const disclosure = (outlet: string, slot = `<slot name="summary"><prop name="label" type="string" default="Details">Text.</prop>` +
      `<prop name="count" type="number" required>Count.</prop><prop name="tone" type="keyword" values="quiet, loud">Tone.</prop></slot>`): string =>
      `<template component="x-disclosure" status="early" summary="D."><defs><prop name="items" type="list(string)" default="[]">Items.</prop>${slot}</defs>` +
      `<button>${outlet}</button></template>`;
    const message = (source: string): string => {
      try { parseComponent(source, "component.html"); } catch (error) { if (error instanceof HtmlDiagnosticError) return `${error.diagnostic.code}: ${error.diagnostic.message}`; }
      return "";
    };
    const definition = parseComponent(disclosure(`<slot name="summary" count="3" tone="loud"></slot>`));
    // The normalized contract lists each declared slot's props, as it lists the component's.
    assert.deepEqual(Object.keys(definition.contract.slots ?? {}), ["summary"]);
    assert.deepEqual(definition.contract.slots?.summary?.props.count, { type: "number", required: true, target: { attribute: "count" }, description: "Count." });
    // A static prop converts by its declared type; a default fills what the outlet leaves out.
    const outlet = definition.template.children[0];
    assert.ok(outlet?.kind === "slot");
    assert.deepEqual(outlet.props?.map(({ name, expression }) => [name, expression]), [["count", "3"], ["tone", "'loud'"], ["label", "'Details'"]]);
    // A bound prop keeps its expression and takes the type its value must conform to.
    const bound = parseComponent(disclosure(`<slot name="summary" label="Open" from:count="$items.length"></slot>`));
    const boundOutlet = bound.template.children[0];
    assert.ok(boundOutlet?.kind === "slot");
    assert.deepEqual(boundOutlet.props?.map(({ name, expression, type }) => [name, expression, type]), [["count", "$items.length", "number"], ["label", "'Open'", undefined]]);
    // A bound prop with a declared default carries it, for a null or rejected value to take.
    const defaulted = parseComponent(disclosure(`<slot name="summary" count="1" from:label="$items.length"></slot>`)).template.children[0];
    assert.ok(defaulted?.kind === "slot");
    assert.deepEqual(defaulted.props?.find((prop) => prop.name === "label")?.default, "Details");
    // Each mistake names the outlet; an undeclared prop names the declaration to add.
    assert.match(message(disclosure(`<slot name="summary" count="1" from:count="$items.length"></slot>`)), /HT008: .*gives prop `count` more than once/);
    assert.match(message(disclosure(`<slot name="summary" count="1" size="2"></slot>`)), /HT008: .*`size`, which slot `summary` does not declare; add <slot name="summary"><prop name="size"/);
    assert.match(message(disclosure(`<slot name="summary" label="x"></slot>`)), /HT008: .*must give prop `count`/);
    assert.match(message(disclosure(`<slot name="summary" count="many"></slot>`)), /HT008: .*the value `many`, which does not satisfy its declared type `number`/);
    assert.match(message(disclosure(`<slot name="summary" count="1" tone="soft"></slot>`)), /HT008: .*the value `soft`/);
    assert.match(message(disclosure(`<slot name="other" from:item="$items"></slot>`)), /HT008: .*gives props to slot `other`, which declares none; declare them in <defs>: <slot name="other"><prop name="item"/);
    // A slot without props is never declared; a declaration declares at least one prop, once.
    assert.match(message(disclosure(`<slot name="summary"></slot>`, `<slot name="summary"></slot>`)), /HC013: .*at least one <prop>/);
    assert.match(message(disclosure(`<slot name="summary" count="1"></slot>`, `<slot name="summary"><prop name="count" type="number">C.</prop></slot><slot name="summary"><prop name="count" type="number">C.</prop></slot>`)), /HC020: Slot `summary` is declared more than once/);
    assert.match(message(disclosure(`<slot></slot>`, `<slot name="label-action"><prop name="a" type="string">A.</prop></slot>`)), /HC013: Slot name `label-action` is not an identifier/);
    // A bound value that reads nothing is known now: one its declared type rejects, checked in full, is an error.
    const row = `<slot name="summary"><prop name="count" type="number" required>C.</prop><prop name="row" type="object">R.<prop name="id" type="string" required>I.</prop></prop></slot>`;
    assert.match(message(disclosure(`<slot name="summary" count="1" from:row="{ id: 'a', extra: 1 }"></slot>`, row)), /HT008: <slot name="summary"> gives prop `row` a value that does not satisfy its declared type `object\(\{ id: string \}\)`/);
    assert.match(message(disclosure(`<slot name="summary" count="1" from:row="{}"></slot>`, row)), /HT008: .*prop `row` a value that does not satisfy/);
    assert.match(message(disclosure(`<slot name="summary" from:count="'3'"></slot>`)), /HT008: .*prop `count` a value that does not satisfy its declared type `number`/);
    parseComponent(disclosure(`<slot name="summary" count="1" from:row="{ id: 'a' }"></slot>`, row));
    // A plain slot needs no declaration, and a declared slot's props may be any type, as only static ones are attributes.
    parseComponent(disclosure(`<slot name="summary" from:count="$items.length"></slot>`, `<slot name="summary"><prop name="count" type="unknown" required>C.</prop></slot>`));
  });

  it("parses repeated scoped slots and exposes their row bindings", () => {
    const definition = parseComponent(
      `<template component="x-rows"><defs><slot name="row"><prop name="item" type="unknown" required>The item.</prop><prop name="index" type="number" required>The index.</prop></slot><prop name="rows" type="list(object({ id: string, name: string }))">Rows.</prop></defs>` +
      `<ul><slot $each="row of $rows" $key="$row.id" name="row" from:item="$row" from:index="$loop.index">` +
      `<li $value="$row.name"></li></slot></ul></template>`,
    );
    const slot = definition.template.children[0];
    assert.ok(slot?.kind === "slot");
    assert.equal(slot.flow?.kind, "each");
    assert.deepEqual(slot.flow?.kind === "each" && slot.flow.listPlan?.dependencies, ["rows"]);
    assert.deepEqual(slot.flow?.kind === "each" && slot.flow.keyPlan?.dependencies, ["row.id"]);
    assert.deepEqual(slot.props?.map((prop) => [prop.name, prop.expressionPlan.dependencies]), [
      ["item", ["row"]], ["index", ["loop.index"]],
    ]);
    assert.deepEqual(definition.slots?.map(({ declared: _declared, ...slot }) => slot), [{ name: "row", required: false, props: ["item", "index"] }]);
    assert.deepEqual(slot.fallback?.[0]?.kind === "element" && slot.fallback[0].attributes[0]?.kind === "directive"
      && slot.fallback[0].attributes[0].expressionPlan?.dependencies, ["row.name"]);
  });

  it("retains every scoped prop when root alternatives expose the same slot", () => {
    const definition = parseComponent(`<template component="x-alternate-slots"><defs><slot name="item"><prop name="first" type="string">The first.</prop><prop name="second" type="string">The second.</prop></slot>` +
      `<state name="first" value="First"></state><state name="second" value="Second"></state>` +
      `<state type="boolean" name="alternate" value="false"></state></defs>` +
      `<template $match><section $when="$alternate"><slot name="item" from:first="$first"></slot></section>` +
      `<article $else><slot name="item" from:second="$second"></slot></article></template></template>`);
    assert.deepEqual(definition.slots?.map(({ declared: _declared, ...slot }) => slot), [{ name: "item", required: true, props: ["first", "second"] }]);
    assert.deepEqual(Object.keys(definition.contract.slots?.item?.props ?? {}), ["first", "second"]);
  });

  it("defers unknown names only inside a consumer's scoped-slot template", () => {
    const definition = parseComponent(`<template component="x-consumer"><defs><state name="heading" value="People"></state></defs>` +
      `<section><x-row-list><template slot="row"><b $value="$item.name"></b><i $value="$heading"></i></template></x-row-list></section></template>`);
    const invocation = definition.template.children[0];
    assert.ok(invocation?.kind === "element");
    const projection = invocation.children[0];
    assert.ok(projection?.kind === "element" && projection.name === "template");
    assert.equal(projection.children[0]?.kind === "element" && projection.children[0].attributes[0]?.kind === "directive" &&
      projection.children[0].attributes[0].expressionPlan?.dependencies[0], "item.name");
    expectDiagnostic("HT003", `<template component="x-invalid"><section><b $value="$item.name"></b></section></template>`);
  });

  it("treats status and summary as optional", () => {
    const definition = parseComponent('<template component="x-plain"><div></div></template>', "plain.html");
    assert.equal(definition.contract.status, undefined);
    assert.equal(definition.contract.summary, undefined);
  });

  it("accepts prop names that exist on Object.prototype", () => {
    const definition = parseComponent(
      componentSource(
        `<button from:data-constructor="$constructor"></button>`,
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
        `<button from:data-value="$value"></button></template>`,
    );
  });

  it("parses ancestor state and aliased read-only context", () => {
    const provider = parseComponent(
      `<template component="x-steps"><defs><state type="number" name="current" value="1"></state></defs>` +
        `<ol><slot></slot></ol></template>`,
    );
    const reader = parseComponent(
      `<template component="x-step"><defs><context name="current" from="x-steps" as="activeStep"></context></defs>` +
        `<li from:aria-current="$activeStep = 1 ? 'step' : null"></li></template>`,
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
        `<button from:data-open="$open"></button></template>`,
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
      { kind: "attribute", name: "data-variant", expression: "$variant" },
      { kind: "attribute", name: "data-size", expression: "$size" },
    ]);
    assert.deepEqual(
      definition.template.attributes
        .filter((attribute) => attribute.kind === "attribute")
        .map((attribute) => attribute.expressionPlan?.dependencies),
      [["variant"], ["size"]],
    );
    assert.deepEqual(definition.template.children, [{ kind: "text", value: "\n    " }, { kind: "slot" }, { kind: "text", value: "\n  " }]);
    assert.match(definition.css, /all: revert/);
    assert.equal(definition.source.file, "x-button.html");
  });

  it("infers property targets through the static DOM contract", () => {
    const source = componentSource(
      `<button .textContent="$message"></button>`,
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
        expression: "$message",
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
      componentSource(`<div .anchorRect="$anchor"></div>`, `<prop name="anchor" type="string">Anchor id.</prop>`),
    );
    expectDiagnostic(
      "HC017",
      componentSource(`<div from:data-anchor="$anchor"></div>`, `<prop name="anchor" type="unknown">Anchor geometry.</prop>`),
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
    expectDiagnostic("HT003", componentSource(`<button from:title="$missing"></button>`));
  });

  it("targets a prop's first binding and lets it bind in more places", () => {
    const definition = parseComponent(
      componentSource(
        `<button from:title="$label" from:aria-label="$label"><span $value="$label"></span></button>`,
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
      componentSource(`<button from:data-x="$v"></button>`, `<prop type="string">No name.</prop>`),
    );
    expectDiagnostic(
      "HC013",
      componentSource(`<button from:data-x="$v"></button>`, `<prop name="v">No type.</prop>`),
    );
    expectDiagnostic(
      "HC018",
      componentSource(
        `<button><slot></slot></button>`,
        `<prop name="ghost" type="string">Never bound.</prop>`,
      ),
    );
  });

  it("reads path fields without the $ marker and accepts it even though it is not required", () => {
    const parse = (sort: string, path = "draft.title") => parseComponent(
      `<template component="demo-paths" status="early" summary="Paths.">` +
        `<defs><state type="object({ title: string })" name="draft" value="{ title: '' }"></state>` +
        `<state type="list(object({ price: number, name: string }))" name="rows" value="[]"></state>` +
        `<handler name="rename"><set name="${path}" value="b"></set></handler></defs>` +
        `<section><input bind:value="${path}"><ul><li $each="row of $rows" $sort="${sort}">{$row.name}</li></ul></section></template>`,
    );
    const shape = (definition: ReturnType<typeof parse>) => {
      const [input, list] = definition.template.children as ElementNode[];
      const handler = definition.declarations?.find((declaration) => declaration.kind === "handler");
      const flow = (list!.children[0] as ElementNode).flow;
      return {
        bind: input!.attributes[0]?.kind === "attribute" ? input!.attributes[0].writablePath : undefined,
        set: handler?.kind === "handler" && handler.steps[0]?.kind === "set" ? handler.steps[0].writablePath : undefined,
        sort: flow?.kind === "each" ? flow.sortKeys : undefined,
      };
    };
    assert.deepEqual(shape(parse("row.price, -row.name, row")), {
      bind: ["draft", "title"], set: ["draft", "title"],
      sort: [{ path: ["price"], descending: false }, { path: ["name"], descending: true }, { path: [], descending: false }],
    });
    assert.deepEqual(shape(parse("$row.price, -$row.name, $row", "$draft.title")), shape(parse("row.price, -row.name, row")));
    // A $sort key starts at the loop item, so a bare field is not read as one.
    assert.throws(() => parse("price, -name"), /`\$sort` key `price` must be a path from the loop item `row`; did you mean `row\.price`\?/);
    assert.throws(() => parse("-name"), /did you mean `-row\.name`\?/);
    assert.throws(() => parse("item.price"), /HT023/);
    expectDiagnostic("HT005", `<template component="demo-paths" status="early" summary="Paths."><defs><state type="number" name="count" value="0"></state></defs><input bind:value="$count + 1"></template>`);
  });

  it("writes through $each, $with, and $match aliases of state paths", () => {
    const parse = (body: string) => parseComponent(`<template component="x-alias" status="early" summary="Aliases."><defs>
      <state name="draft" type="object({ owner: object({ name: string }), plan: string })" value="{ owner: { name: 'Ada' }, plan: 'free' }"></state>
      <state name="rows" type="list(object({ label: string }))" value="[]"></state>
      <state name="tags" type="list(string)" value="[]"></state>
      <prop name="title" type="string">Title.</prop></defs><section>${body}</section></template>`);
    const writes = (node: unknown): unknown[] => {
      if (node === null || typeof node !== "object") return [];
      const own = (node as { twoWay?: boolean }).twoWay === true ? [(node as unknown as { writablePath: unknown }).writablePath] : [];
      return [...own, ...Object.values(node).flatMap(writes)];
    };
    const loopIndex = { kind: "index", item: "row", expression: { kind: "member", object: { kind: "id", name: "loop" }, key: "index" } };
    assert.deepEqual(writes(parse(`<div $with="$draft.owner as owner"><input bind:value="owner.name"></div>` +
      `<template $match="$draft as d"><input $when="$d.plan" bind:value="d.plan"><i $else></i></template>` +
      `<p $each="row of $rows"><input bind:value="row.label"></p>` +
      `<p $each="row, i of $rows"><b $each="n of [1]"><input bind:value="row.label"></b></p>`).template), [
      ["draft", "owner", "name"],
      ["draft", "plan"],
      ["rows", loopIndex, "label"],
      ["rows", { kind: "index", item: "row", expression: { kind: "id", name: "i" } }, "label"],
    ]);
    const refused = (body: string, reason: RegExp) => assert.throws(() => parse(body), (error: unknown) =>
      error instanceof HtmlDiagnosticError && error.diagnostic.code === "HT005" && reason.test(error.diagnostic.message));
    refused(`<p $each="row of $rows"><b $each="n of [1]"><input bind:value="row.label"></b></p>`, /name that loop's index/);
    refused(`<p $each="row of $rows" $where="$row.label"><input bind:value="row.label"></p>`, /\$where`, `\$sort`, or `\$limit` list/);
    refused(`<p $each="row, i of $rows"><input bind:value="i"></p>`, /`i` is a loop index/);
    refused(`<div $with="$title as draft"><input bind:value="draft.plan"></div>`, /`draft` stands for `\$title`, which is not a writable state path/);
    refused(`<p $each="t of ['a']"><input bind:value="t"></p>`, /not declared state/);
    refused(`<p $each="t of $tags"><input bind:value="t"></p>`, /`t` is a whole loop item; bind one of its fields/);
  });

  it("parses state-rooted two-way bindings, flow, content, refs, and events", () => {
    const definition = parseComponent(
      `<template component="demo-example" status="early" summary="Bindings.">` +
        `<defs><state type="object({ email: string })" name="form" value="{ email: '' }"></state>` +
        `<handler name="save"></handler></defs>` +
        `<form><input bind:value="form.email" $ref="email" on:input.passive="save">` +
        `<output $if="$form.email" $value="$form.email"></output></form></template>`,
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
    assert.equal(output.flow?.kind === "if" && output.flow.test, "$form.email");
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
        `<computed name="hasQuery" from="$query != ''"></computed>` +
        `<data name="results" src="/api/search" type="object" debounce="150ms" poll="30s">` +
        `<param name="q" from:value="$query"></param></data>` +
        `<event name="selection-change" type="number" bubbles="false" composed="false" cancelable="true"></event>` +
        `<handler name="select">` +
        `<set name="form.selected" expr:value="$form.selected + 1" $if="$hasQuery"></set>` +
        `<validate target="search"></validate><focus ref="search"></focus>` +
        `<dispatch event="selection-change" expr:value="$form.selected"></dispatch>` +
        `</handler></defs>` +
        `<section from:data-ready="$hasQuery" class:active="$hasQuery" style:opacity="$hasQuery" $ref="root">` +
        `<input .value="$query" bind:data-index="form.selected" $ref="search" on:input.capture.once="select">` +
        `<ol><li $each="row, i of $results.value" $where="$row.visible" $sort="-row.score,row.name" $limit="3" $key="$row.id">` +
        `<slot name="row"><span $value="$i"></span></slot></li></ol>` +
        `<div $with="$form as current"><output $value="$current.selected"></output></div>` +
        `<div $match="$form as current"><span $when="$current.selected > 0">Selected</span><span $else>None</span></div>` +
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
    assert.deepEqual(definition.slots, [{ name: "row", required: false }]);
  });

  it("records polymorphic native roots and delegated component roots", () => {
    // The spec's polymorphic root: an ordinary `as` prop chooses between explicit native roots.
    const button = (root: string, defs = `<prop name="as" type="keyword" values="button, a" default="button">Root.</prop>`) =>
      `<template component="x-button" status="early" summary="Polymorphic."><defs>${defs}</defs>${root}</template>`;
    const polymorphic = parseComponent(button(
      `<template $match><a $when="$as = 'a'" $ref="control"><slot name="icon"></slot><slot></slot></a>` +
        `<button $else type="button" $ref="control"><slot name="icon"></slot><slot></slot></button></template>`,
    ));
    assert.deepEqual(polymorphic.root, { kind: "native", element: "button", choices: ["a", "button"] });
    assert.equal(polymorphic.contract.nativeElement, "button");
    // Each arm declares the same slots; the contract lists each once.
    assert.deepEqual(polymorphic.slots, [{ name: "icon", required: true }, { required: true }]);
    // `as` does not retag an element.
    expectDiagnostic("HT021", componentSource(`<button as="button|a"></button>`));
    // Exactly one native root is always chosen.
    expectDiagnostic("HT021", button(`<template $match><a $when="$as = 'a'"></a><button $when="$as = 'button'"></button></template>`));
    expectDiagnostic("HT021", button(`<template $match><template $when="$as = 'a'"><a></a></template><button $else></button></template>`));
    expectDiagnostic("HT021", button(`<template $match="$as"><a $when="$as = 'a'"></a><button $else></button></template>`));
    // Arms read props, state, and computed values, like any expression.
    assert.deepEqual(parseComponent(button(
      `<template $match><details $when="$open"></details><a $when="$linked"></a><button $else></button></template>`,
      `<prop name="as" type="keyword" values="button, a" default="button">Root.</prop><state type="boolean" name="open" value="false"></state>` +
        `<computed name="linked" from="$as = 'a'"></computed>`,
    )).root, { kind: "native", element: "button", choices: ["details", "a", "button"] });
    // A slot required by any arm is required.
    const merged = parseComponent(button(
      `<template $match><a $when="$as = 'a'"><slot name="icon"></slot><slot name="label"></slot></a>` +
        `<button $else><slot name="icon">★</slot><slot name="label">fallback</slot></button></template>`,
    ));
    assert.deepEqual(merged.slots, [{ name: "icon", required: true }, { name: "label", required: true }]);
    // A slot is not a native root.
    expectDiagnostic("HT021", button(`<template $match><slot></slot><button $else></button></template>`));
    // A slot is still declared once within an arm.
    expectDiagnostic("HT008", button(`<template $match><a $when="$as = 'a'"><slot></slot><slot></slot></a><button $else></button></template>`));

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
        `<button .innerHTML="$markup"></button>`,
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
        `<button .outerHTML="$markup"></button>`,
        `<prop name="markup" type="string">Replacement markup.</prop>`,
      ),
    );
    expectDiagnostic(
      "HT007",
      componentSource(
        `<iframe .srcdoc="$markup"></iframe>`,
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

  it("reads on:connect and on:disconnect on the native root as the component's lifecycle handlers", () => {
    const declarations = `<defs><state type="boolean" name="ready" value="false"></state>` +
      `<handler name="markReady"><set name="ready" value="true"></set></handler>` +
      `<handler name="markGone"><set name="ready" value="false"></set></handler></defs>`;
    const definition = parseComponent(`<template component="demo-example">${declarations}` +
      `<section on:connect="markReady" on:disconnect="markGone" on:click="markReady"></section></template>`);
    assert.deepEqual(definition.lifecycle, { connect: "markReady", disconnect: "markGone" });
    assert.deepEqual(definition.template.events, [{ name: "click", handler: "markReady", modifiers: [] }]);
    assert.equal(parseComponent(`<template component="demo-example">${declarations}<section on:connect="markReady"></section></template>`).template.events, undefined);
    for (const attribute of ["on:connect", "on:disconnect"]) {
      // Only the element the component always renders as its own root has its lifecycle.
      expectDiagnostic("HT010", `<template component="demo-example">${declarations}<section><span ${attribute}="markReady"></span></section></template>`);
      expectDiagnostic("HT010", `<template component="demo-example">${declarations}<template $match=""><p $when="$ready" ${attribute}="markReady"></p><p $else></p></template></template>`);
      expectDiagnostic("HT010", `<template component="demo-example">${declarations}<x-other ${attribute}="markReady"></x-other></template>`);
      expectDiagnostic("HT010", `<template component="demo-example">${declarations}<section ${attribute}.once="markReady"></section></template>`);
      expectDiagnostic("HT010", `<template component="demo-example">${declarations}<section ${attribute}="missing"></section></template>`);
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
      `<output from:data-status="$status"></output></template>`,
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
        `<output from:data-status="$status"></output></template>`,
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


describe("ref-targeted dispatch", () => {
  const source = (target: string, body = '<button $ref="customer"></button>') =>
    `<template component="x-dispatch"><defs><event name="validate" type="number"></event><handler name="check"><dispatch event="validate" target="${target}" value="3"></dispatch></handler></defs><section>${body}</section></template>`;

  it("retains the component-local target and typed constant payload", () => {
    const definition = parseComponent(source("customer"));
    const handler = definition.declarations?.find((entry) => entry.kind === "handler");
    assert.equal(handler?.kind, "handler");
    if (handler?.kind !== "handler") return;
    assert.equal(handler.steps[0]?.kind, "dispatch");
    assert.equal((handler.steps[0] as unknown as { target: string }).target, "customer");
    assert.equal(handler.steps[0]?.kind === "dispatch" && handler.steps[0].value?.source, "3");
  });

  it("rejects invalid and unknown targets", () => {
    for (const target of ["", "#customer", "missing"]) expectDiagnostic("HC023", source(target));
    assert.doesNotThrow(() => parseComponent(source("customer", '<ul $each="item of [1, 2]"><li $ref="customer"></li></ul>')));
  });
});

describe("template whitespace", () => {
  // Shiki's code blocks separate `.line` spans with "\n" text nodes that hold no other text.
  const source = `<template component="x-code"><section>
    <pre class="shiki"><code><span class="line">a</span>
<span class="line">b</span><template $if="true"> </template><slot>
</slot></code></pre>
    <p><strong>Package:</strong> <code>x</code> and <em>a</em> <em>b</em></p>
    <p><em>a</em>
      <em>b</em> <!-- note --> <b>c</b>&nbsp;<i>d</i></p>
    <listing><b>l</b>
<b>m</b></listing><textarea>
  </textarea>
    <table>
      <tbody>
        <tr $each="row of [1]">
          <td> <b>1</b> </td>
        </tr>
      </tbody>
    </table>
    <svg><defs>
      <g></g>
    </defs><text> <tspan>a</tspan> <tspan>b</tspan></text></svg>
    <output $value="'x'">
    </output>
    <x-card>
      <b slot="title">t</b>
      <i>a</i> <i>b</i>
    </x-card>
  </section></template>`;
  const shape = (node: ElementNode): string[] => node.children.map((child) =>
    child.kind === "text" ? child.value : child.kind === "element" ? child.name : child.kind);
  for (const [mode, parse] of [
    ["parse5", () => parseComponent(source)],
    ["browser", () => parseBrowserComponent(new JSDOM(source).window.document.querySelector("template")!, "code.html")],
  ] as const) {
    it(`keeps whitespace-only text where it can render, in ${mode} parsing`, () => {
      const { template } = parse();
      const [pre, inline, wrapped, listing, textarea, table, svg, output, card] = template.children.filter((child): child is ElementNode => child.kind === "element");
      const indent = "\n    ";
      assert.deepEqual(shape(template), [indent, "pre", indent, "p", indent, "p", indent, "listing", "textarea", indent, "table", indent, "svg", indent, "output", indent, "x-card", "\n  "]);
      const code = pre!.children[0] as ElementNode;
      assert.deepEqual(shape(code), ["span", "\n", "span", "template", "slot"]);
      assert.deepEqual(shape(code.children[3] as ElementNode), [" "]);
      assert.deepEqual((code.children[4] as { fallback: unknown }).fallback, [{ kind: "text", value: "\n" }]);
      // Between inline elements, as in a hand-written page: a space, or a line break and indentation.
      assert.deepEqual(shape(inline!), ["strong", " ", "code", " and ", "em", " ", "em"]);
      // Text a comment splits is one run, as it renders; a non-breaking space is not HTML whitespace.
      assert.deepEqual(shape(wrapped!), ["em", "\n      ", "em", "  ", "b", "\u00a0", "i"]);
      assert.deepEqual(shape(listing!), ["b", "\n", "b"]);
      assert.deepEqual(shape(textarea!), ["  "]);
      // Table structure and SVG containers never render whitespace-only text; a cell and <text> do.
      const tbody = table!.children[0] as ElementNode;
      const row = tbody.children[0] as ElementNode;
      assert.deepEqual([shape(table!), shape(tbody), shape(row)], [["tbody"], ["tr"], ["td"]]);
      assert.deepEqual(shape(row.children[0] as ElementNode), [" ", "b", " "]);
      assert.deepEqual(shape(svg!), ["defs", "text"]);
      assert.deepEqual(shape(svg!.children[0] as ElementNode), ["g"]);
      assert.deepEqual(shape(svg!.children[1] as ElementNode), [" ", "tspan", " ", "tspan"]);
      // A content directive replaces its element's children, so whitespace beside it is layout.
      assert.deepEqual(output!.children, []);
      // Around a component's projected content and its named-slot content, whitespace is layout.
      assert.deepEqual(shape(card!), ["b", "i", " ", "i"]);
    });
  }
});

describe("browser-parsed components", () => {
  it("warns in the console when a bare keyword spells a name in scope", () => {
    const warnings: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("warn", (message: string) => warnings.push(message));
    const { document } = new JSDOM(`<template component="x-count" status="early" summary="Count.">
      <defs><state name="count" type="number" value="1"></state></defs>
      <p from:title="count" from:data-mode="compact">{$count + 1}</p></template>`, { virtualConsole }).window;
    parseBrowserComponent(document.querySelector("template")!, "count.html");
    assert.deepEqual(warnings, ["count.html: HT022: `count` is a keyword, not a reference; did you mean `$count`? (in `count`)"]);
  });
});

describe("requests", () => {
  const editor = (defs: string, root = "<div></div>"): string =>
    `<template component="ui-editor" status="early" summary="Asks its consumer." controller="./editor.js"><defs>${defs}</defs>${root}</template>`;

  it("declares a request's detail and answer in attribute and expanded forms", () => {
    const { contract } = parseComponent(editor(`
      <request name="mention-query" type="object({ query: string })" returns="list(object({ id: string, label: string }))">People matching the text after @.</request>
      <request name="image-upload" type="object">
        <prop name="file" type="unknown" required>The File the author dropped or pasted.</prop>
        <returns type="object"><prop name="src" type="string" required></prop><prop name="width" type="integer"></prop></returns>
      </request>
      <request name="extensions" returns="list(unknown)"></request>
      <request name="pick" type="event"></request>`), "editor.html");
    assert.deepEqual(Object.keys(contract.requests ?? {}), ["mention-query", "image-upload", "extensions", "pick"]);
    const requests = contract.requests!;
    assert.equal(formatType(requests["mention-query"]!.type), "object({ query: string })");
    assert.equal(formatType(requests["mention-query"]!.returns), "list(object({ id: string, label: string }))");
    assert.equal(requests["mention-query"]!.description, "People matching the text after @.");
    assert.equal(formatType(requests["image-upload"]!.type), "object({ file: unknown })");
    assert.equal(formatType(requests["image-upload"]!.returns), "object({ src: string, width?: integer })");
    assert.equal(requests["image-upload"]!.description, undefined);
    // Omitted, the detail is null and the answer unknown; `event` and `unknown` need no attribute form.
    assert.equal(formatType(requests.extensions!.type), "null");
    assert.equal(formatType(requests.pick!.returns), "unknown");
    assert.equal(formatType(requests.pick!.type), "event");
    // A request is not a prop, and a component without one has no requests.
    assert.deepEqual(Object.keys(contract.props), []);
    assert.equal(parseComponent(editor("")).contract.requests, undefined);
  });

  it("fails a build that names a request like an event, the responder host event, or a framework prop", () => {
    expectDiagnostic("HC010", editor(`<request name="responder"></request>`));
    expectDiagnostic("HC010", editor(`<event name="responder"></event>`));
    expectDiagnostic("HC020", editor(`<event name="ask"></event><request name="ask"></request>`));
    expectDiagnostic("HC020", editor(`<request name="ask"></request><event name="ask"></event>`));
    expectDiagnostic("HC020", editor(`<request name="ask"></request><request name="ask"></request>`));
    expectDiagnostic("HC010", editor(`<request name="mentionQuery"></request>`));
    expectDiagnostic("HC011", editor(`<prop name="mentionQuery" type="string">Query.</prop><request name="mention-query"></request>`, `<div from:title="$mentionQuery"></div>`));
    expectDiagnostic("HC013", editor(`<request name="ask" returns="string"><returns type="string"></returns></request>`));
    expectDiagnostic("HC013", editor(`<request name="ask"><prop name="file" type="unknown">File.</prop></request>`));
  });

  it("warns and ignores those declarations in the live parser", () => {
    const warnings: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("warn", (message: string) => warnings.push(message));
    const { document } = new JSDOM(editor(`<request name="responder"></request><event name="ask"></event><request name="ask"></request>
      <prop name="mentionQuery" type="string">Query.</prop><request name="mention-query"></request>`, `<div from:title="$mentionQuery"></div>`), { virtualConsole }).window;
    const definition = parseBrowserComponent(document.querySelector("template")!, "editor.html");
    // A framework function prop does not exist live, so only the build reports that collision.
    assert.deepEqual(Object.keys(definition.contract.requests ?? {}), ["mention-query"]);
    assert.ok(definition.declarations?.some((declaration) => declaration.kind === "event" && declaration.name === "ask"));
    assert.deepEqual(warnings.map((warning) => warning.split(": ").slice(0, 2).join(": ")), ["editor.html: HC010", "editor.html: HC020"]);
  });
});

describe("head declarations", () => {
  const page = (defs: string, root = "<main></main>"): string =>
    `<template component="page-checkout" status="early" summary="Takes a payment."><defs>${defs}</defs>${root}</template>`;

  it("reads titles, metadata, links, JSON-LD and declared scripts from <defs>", () => {
    const definition = parseComponent(page(`
      <prop name="pk" type="string" required>The publishable key.</prop>
      <state name="ready" type="boolean" value="false"></state>
      <handler name="enable"><set name="ready" value="true"></set></handler>
      <title>{$pk} · Checkout</title>
      <meta name="description" from:content="$pk">
      <meta property="og:image" content="/card.png"><meta property="og:image:width" content="1200">
      <link rel="preconnect" href="https://js.stripe.com" crossorigin>
      <link rel="canonical" from:href="$pk">
      <script type="application/ld+json">{"@type": "Product", "name": "{literal braces}"}</script>
      <script type="application/ld+json" from:value="$pk"></script>
      <script name="stripe" src="https://js.stripe.com/v3/" loading="lazy" on:load="enable" on:error="enable"
              integrity="sha384-abc" crossorigin="anonymous" referrerpolicy="no-referrer" fetchpriority="low"></script>
      <script src="https://maps.example/sdk.js" type="module"></script>`, `<main from:aria-busy="$stripe.pending" from:title="$pk"></main>`), "checkout.html");
    const head = definition.head!;
    assert.deepEqual(head.map((declaration) => declaration.kind), ["title", "meta", "meta", "meta", "link", "link", "json", "json"]);
    const title = head[0] as Extract<typeof head[number], { kind: "title" }>;
    assert.deepEqual(title.text[0]!.segments?.map((segment) => segment.expressionPlan?.source ?? segment.value), ["$pk", " · Checkout"]);
    const description = head[1] as Extract<typeof head[number], { kind: "meta" | "link" }>;
    assert.deepEqual(description.attributes.map((attribute) => [attribute.kind, attribute.name]), [["literal", "name"], ["attribute", "content"]]);
    // Literal JSON-LD is inert text: braces in it are not expressions.
    assert.equal((head[6] as { text?: string }).text, '{"@type": "Product", "name": "{literal braces}"}');
    assert.equal((head[7] as { value?: { source: string } }).value?.source, "$pk");
    assert.deepEqual(definition.scripts, [
      { src: "https://js.stripe.com/v3/", loading: "lazy", name: "stripe", load: "enable", error: "enable", integrity: "sha384-abc",
        crossorigin: "anonymous", referrerpolicy: "no-referrer", fetchpriority: "low" },
      { src: "https://maps.example/sdk.js", loading: "eager", type: "module" },
    ]);
    // The contract lists the scripts a component loads, without its handlers.
    assert.deepEqual(definition.contract.scripts, [
      { src: "https://js.stripe.com/v3/", loading: "lazy", name: "stripe", integrity: "sha384-abc", crossorigin: "anonymous",
        referrerpolicy: "no-referrer", fetchpriority: "low" },
      { src: "https://maps.example/sdk.js", loading: "eager", type: "module" },
    ]);
    // Whitespace between head declarations is insignificant, as between other declarations, and never renders.
    const spaced = parseComponent(page('\n  <title>Pay</title>\n  <meta name="description" content="Pay.">\n  ', "<main>\n</main>"));
    const compact = parseComponent(page('<title>Pay</title><meta name="description" content="Pay.">', "<main>\n</main>"));
    assert.deepEqual(spaced.head, compact.head);
    assert.deepEqual(spaced.template, compact.template);
    const plain = parseComponent(page(""));
    assert.equal(plain.head, undefined);
    assert.equal(plain.scripts, undefined);
    assert.equal(plain.contract.scripts, undefined);
  });

  it("rejects policy elements, inline code and attributes a head element does not define", () => {
    const invalid: readonly (readonly [string, string])[] = [
      ["HC025", '<meta http-equiv="refresh" content="0; url=https://evil.example/">'],
      ["HC025", '<meta http-equiv="content-security-policy" content="script-src *">'],
      ["HC025", '<meta charset="utf-8">'],
      ["HC025", "<base href=\"https://evil.example/\">"],
      ["HC025", '<link rel="stylesheet" href="./page.css">'],
      ["HC025", '<link rel="import" href="./other.html">'],
      ["HC025", '<link rel="search" href="/opensearch.xml">'],
      ["HC025", '<link rel="preconnect" href="https://a.example" blocking="render">'],
      ["HC025", '<link rel="preconnect" href="https://a.example" onload="run()">'],
      ["HC025", '<link rel="preconnect" from:rel="$x" href="https://a.example">'],
      ["HC025", '<link rel="preconnect">'],
      ["HC025", "<script>alert(1)</script>"],
      ["HC025", '<script type="importmap">{"imports": {}}</script>'],
      ["HC025", '<script type="speculationrules">{}</script>'],
      ["HC025", '<script type="text/plain" src="https://a.example/a.js"></script>'],
      ["HC025", '<script src="https://a.example/a.js">run()</script>'],
      ["HC025", '<script src="https://a.example/a.js" async></script>'],
      ["HC025", '<script src="https://a.example/a.js" defer></script>'],
      ["HC025", '<script src="https://a.example/a.js" nonce="abc"></script>'],
      ["HC025", '<script src="https://a.example/a.js" blocking="render"></script>'],
      ["HC025", '<script src="https://a.example/a.js" loading="idle"></script>'],
      ["HC025", '<script src="https://a.example/a.js" loading="manual"></script>'],
      ["HC025", '<script src=""></script>'],
      ["HC025", '<meta name="description">'],
      ["HC025", '<meta name="description" property="og:description" content="Both">'],
      ["HC025", '<meta name="description" content="Literal" from:content="$x">'],
      ["HC025", "<title lang=\"en\">Pricing</title>"],
      ["HC026", '<script type="application/ld+json">{"@type": "Product",}</script>'],
      ["HC026", '<script type="application/ld+json"></script>'],
      ["HC026", '<script type="application/ld+json" from:value="$x">{"@type": "Product"}</script>'],
      ["HC026", '<script type="application/ld+json" id="schema">{}</script>'],
      ["HC027", "<title>One</title><title>Two</title>"],
      ["HC027", '<link rel="canonical" href="https://a.example/"><link rel="canonical" href="https://b.example/">'],
      ["HC027", '<link rel="preconnect" href="https://a.example"><link rel="preconnect" href="https://a.example">'],
      ["HC020", '<state name="stripe" value="1"></state><script name="stripe" src="https://js.stripe.com/v3/"></script>'],
      ["HC028", '<meta name="component-src" content="*">'],
      ["HT010", '<script src="https://a.example/a.js" on:load="missing"></script>'],
      ["HT007", '<script src="javascript:alert(1)"></script>'],
      ["HT009", "<handler name=\"nested\"><meta name=\"description\" content=\"Nested\"></handler>"],
    ];
    for (const [code, defs] of invalid) {
      assert.throws(() => parseComponent(page(`<state name="x" value="1"></state>${defs}`), "checkout.html"),
        (error: unknown) => error instanceof HtmlDiagnosticError && error.diagnostic.code === code, `${code}: ${defs}`);
    }
    // Head elements never render, so they remain invalid in the markup.
    expectDiagnostic("HT009", page("", '<main><meta name="description" content="Nested"></main>'));
    expectDiagnostic("HT009", page("", '<main><script src="https://a.example/a.js"></script></main>'));
  });

  it("rejects the same elements read by the browser's parser, and ignores a component's `component-src` list", () => {
    const warnings: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("warn", (message: string) => warnings.push(message));
    const { document } = new JSDOM(page(`<title>Checkout</title><meta name="component-src" content="*">
      <script type="application/ld+json">{"@type": "Product"}</script>`) +
      page("<script>alert(1)</script>").replace("page-checkout", "page-inline") +
      page('<meta http-equiv="refresh" content="0">').replace("page-checkout", "page-refresh"), { virtualConsole }).window;
    const [checkout, inline, refresh] = document.querySelectorAll("template");
    const definition = parseBrowserComponent(checkout!, "checkout.html");
    assert.deepEqual(definition.head?.map((declaration) => declaration.kind), ["title", "json"]);
    assert.deepEqual(warnings.map((warning) => warning.split(": ").slice(0, 2).join(": ")), ["checkout.html: HC028"]);
    // The browser parses scripts in <defs> inertly; the definition is rejected without running one.
    for (const carrier of [inline!, refresh!]) {
      assert.throws(() => parseBrowserComponent(carrier, "page.html"), (error: unknown) => error instanceof HtmlDiagnosticError && error.diagnostic.code === "HC025");
    }
  });
});
