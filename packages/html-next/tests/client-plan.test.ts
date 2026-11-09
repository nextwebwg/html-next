import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { analyzeClientPlan } from "../src/client-plan.js";
import { parseComponent } from "../src/source-parser.js";
import type { ComponentDefinition } from "../src/template.js";

const component = (tag: string, template: string, defs = ""): ComponentDefinition =>
  parseComponent(`<template component="${tag}"><defs>${defs}</defs>${template}</template>`);
const counter = () => component("x-counter", '<button on:click="add">{$count}</button>',
  '<state name="count" type="number" value="0"></state><handler name="add"><set name="count" expr:value="$count + 1"></set></handler>');

describe("shared client plan", () => {
  it("leaves pure bindings, state seeds, computed values, and CSS on the server", () => {
    const definition = component("x-static", '<div from:title="$label"><b $if="$show">{$label}</b></div>',
      '<prop name="label" type="string">Label.</prop><state name="show" type="boolean" value="true"></state>');
    const plan = analyzeClientPlan([{ ...definition, css: "div { color: red }" }]);
    assert.deepEqual(plan.adoption, []);
    assert.deepEqual(plan.creation, []);
    assert.equal(plan.components[0]!.adopt, false);
  });

  it("keeps events in every authored branch without consulting the SSR data", () => {
    const active = counter();
    const owner = component("x-owner", '<main><x-counter $if="false"></x-counter></main>');
    const unused = component("x-unused", "<aside>Static sibling entry</aside>");
    const before = JSON.stringify([owner, active, unused]);
    const plan = analyzeClientPlan([owner, active, unused]);
    assert.deepEqual(plan.adoption, ["x-counter", "x-owner"]);
    assert.deepEqual(plan.creation, plan.adoption);
    assert.ok(plan.components.find(item => item.tag === "x-owner")!.reasons.includes("owns:x-counter"));
    assert.equal(JSON.stringify([owner, active, unused]), before);
  });

  it("retains static invoked factories that an interactive owner can create later", () => {
    const active = counter();
    const owner = { ...active, template: { ...active.template, children: [
      ...active.template.children, component("x-temp", "<x-label></x-label>").template,
    ] } };
    const label = component("x-label", "<span>Label</span>");
    assert.deepEqual(analyzeClientPlan([owner, label]).creation, ["x-counter", "x-label"]);
  });

  it("distinguishes navigation creation from public access to existing hosts", () => {
    const definition = component("x-static", "<div>Static</div>");
    const navigation = analyzeClientPlan([definition], { creationRoots: "all" });
    assert.deepEqual(navigation.adoption, []);
    assert.deepEqual(navigation.creation, ["x-static"]);
    assert.deepEqual(analyzeClientPlan([definition], { publicRoots: "all" }).adoption, ["x-static"]);
  });

  it("keeps opaque modules and controllers, even without declarative events", () => {
    const a = component("x-a", "<div></div>");
    const b = component("x-b", "<div></div>");
    assert.deepEqual(analyzeClientPlan([{ ...a, module: "./behavior.js" }, { ...b, controller: "./legacy.js" }]).adoption, ["x-a", "x-b"]);
    assert.deepEqual(analyzeClientPlan([{ ...a, module: "./behavior.js" }, b], { entries: ["x-a"] }).adoption, ["x-a", "x-b"]);
    assert.deepEqual(analyzeClientPlan([{ ...a, module: "./behavior.js" }, b], { entries: ["x-a"], publicRoots: [] }).adoption, ["x-a", "x-b"]);
  });

  it("keeps two-way bindings and data reads without a module", () => {
    const input = component("x-input", '<input bind:value="$text">', '<state name="text" type="string" value=""></state>');
    const read = component("x-read", "<div></div>");
    const plan = analyzeClientPlan([input, { ...read, declarations: [{ kind: "data", name: "rows", source: "/rows.json", parameters: [] }] }]);
    assert.deepEqual(plan.adoption, ["x-input", "x-read"]);
  });

  it("retains context providers and their ownership region across separate entries", () => {
    const provider = component("x-provider", "<section><slot></slot></section>", '<state name="theme" type="string" value="light"></state>');
    const reader = component("x-reader", "<p>{$theme}</p>", '<context name="theme" from="x-provider"></context>');
    const plan = analyzeClientPlan([reader, provider], { entries: ["x-reader"] });
    assert.deepEqual(plan.adoption, ["x-provider", "x-reader"]);
    const other = component("x-other", "<aside></aside>");
    assert.deepEqual(analyzeClientPlan([reader, { ...provider, module: "./provider.js" }, other],
      { entries: ["x-reader"] }).adoption, ["x-other", "x-provider", "x-reader"]);
  });

  it("keeps slot fallbacks, accepted children, and polymorphic root ownership", () => {
    const box = component("x-box", "<div><slot></slot></div>");
    const choice = { ...box, slots: [{ required: false, accepts: ["x-counter"] }] };
    assert.deepEqual(analyzeClientPlan([choice, counter()]).adoption, ["x-box", "x-counter"]);
    const alias = { ...component("x-alias", "<div></div>"), root: { kind: "component" as const, tag: "x-counter" } };
    assert.deepEqual(analyzeClientPlan([alias, counter()]).adoption, ["x-alias", "x-counter"]);
    const fallback = component("x-fallback", "<div><slot><x-counter></x-counter></slot></div>");
    assert.deepEqual(analyzeClientPlan([fallback, counter()]).adoption, ["x-counter", "x-fallback"]);
  });

  it("terminates recursive ownership graphs and excludes unreachable behavior", () => {
    const a = component("x-a", "<div><x-b></x-b></div>");
    const b = { ...component("x-b", "<div><x-a></x-a></div>"), module: "./b.js" };
    const plain = component("x-plain", "<div></div>");
    assert.deepEqual(analyzeClientPlan([a, b, plain], { entries: ["x-plain"] }).adoption, []);
    assert.deepEqual(analyzeClientPlan([a, b, plain], { entries: ["x-a"] }).adoption, ["x-a", "x-b", "x-plain"]);
  });

  it("produces frozen, deterministic JSON and diagnoses ambiguous build inputs", () => {
    const a = counter();
    const b = component("x-static", "<span></span>");
    const first = analyzeClientPlan([a, b]);
    assert.equal(JSON.stringify(first), JSON.stringify(analyzeClientPlan([b, a])));
    assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
    assert.ok(Object.isFrozen(first.components[0]!.reasons));
    assert.throws(() => analyzeClientPlan([a, a]), /duplicate <x-counter>/);
    assert.throws(() => analyzeClientPlan([a], { publicRoots: ["x-absent"] }), /no definition for <x-absent>/);
  });
});
