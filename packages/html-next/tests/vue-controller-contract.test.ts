import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { generateComponent, vueHostArtifact } from "../src/generate.js";
import { parseComponent } from "../src/source-parser.js";

describe("Vue controller contract", () => {
  it("passes the native triggering event and emits typed controller destinations", () => {
    const definition = parseComponent(`<template component="x-contract" controller="./controller.js"><defs>
      <state name="count" type="number" value="1"></state>
      <computed name="doubled" from="$count * 2"></computed>
      <data name="search" src="/search"></data>
      <event name="activate" type="event"></event>
      <handler name="activate"><dispatch event="activate" expr:value="$$event" $if="$$event.type = 'click'"></dispatch></handler>
      </defs><button on:click="activate">{$doubled}</button></template>`);
    const source = generateComponent(definition).find((artifact) => artifact.path.endsWith('.vue'))!.content;
    assert.match(source, /dispatch\(['"]activate['"], event\)/);
    assert.match(source, /acceptsControllerWrite/);
    assert.match(source, /data: \{ search/);
    assert.doesNotMatch(source, /defineExpose|ready\(\)|Controller method/);
    const host = vueHostArtifact().content;
    assert.match(host, /controllerNamespaces/);
    assert.match(host, /on\(type: string/);
    assert.doesNotMatch(host, /Only declared state is writable/);
  });
});
