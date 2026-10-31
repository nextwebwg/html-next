export const angularControls = `<template component="ui-button"><defs>
  <prop name="label" type="string" required>Label.</prop>
  <state name="count" type="integer" value="0"></state>
  <computed name="double" type="integer" from="$count * 2"></computed>
  <handler name="increment"><set name="count" expr:value="$count + 1"></set></handler>
  <title>Count {$count}</title></defs><button type="button" on:click="increment"><span>{$label}</span><output>{$double}</output><slot></slot></button>
  <style>:host { color: rgb(1, 2, 3); } output { font-weight: bold; } :host(:state(count)) { font-style: italic; } :slotted(strong) { color: rgb(4, 5, 6); }</style></template>
  <template component="ui-action"><defs><prop name="text" type="string" default="Save">Label.</prop>
    <event name="saved" type="integer"></event><handler name="notify"><dispatch event="saved" expr:value="1"></dispatch></handler></defs>
  <ui-button from:label="$text" on:keydown="notify"><b>Action</b><slot></slot></ui-button><style>:host { border-width: 3px; }</style></template>
  <template component="ui-form"><defs>
    <state name="name" type="string" value="Ada"></state>
    <state name="enabled" type="boolean" value="false"></state>
    <state name="choice" type="string" value="b"></state>
  </defs><form>
    <input aria-label="Name" value="Default" bind:value="name">
    <input type="checkbox" aria-label="Enabled" checked bind:checked="enabled">
    <select aria-label="Choice" bind:value="choice"><option value="a" selected>A</option><option value="b">B</option></select>
    <output>{$name}</output>
  </form></template>
  <template component="ui-rows"><defs>
    <prop name="title" type="string" default="People">Title.</prop>
    <state name="seed" type="string" from="$title"></state>
    <state name="rows" type="list(object({ id: integer, name: string }))" value="[{ id: 2, name: 'Bea' }, { id: 1, name: 'Ada' }]"></state>
  </defs><section $with="$title as heading" from:aria-label="$heading">
    <h2>{$seed}</h2><ul><li $each="row, i of $rows" $sort="row.id" $key="$row.id" from:data-index="$i">{$row.name}</li></ul>
    <template $match="$title as name"><strong $when="$name = 'People'">Ready</strong><small $else>Other</small></template>
    <b $if="true" class:active="true" style:--count="2"><template $value="'Visible'"></template></b>
  </section></template>
  <template component="ui-connected" module="./connected.js"><defs>
    <prop name="message" type="string">Connection result.</prop>
    <state name="count" type="integer" value="0"></state>
  </defs><aside><output>{$count}</output><span>{$message}</span><ui-reader></ui-reader></aside></template>
  <template component="ui-reader"><defs><context name="count" from="ui-connected" as="provided"></context></defs><small>{$provided}</small></template>
  <template component="ui-feed"><defs><data name="result" src="/api/name" type="object({ name: string })"></data></defs>
    <div><output>{$result.value.name}</output></div></template>
  <template component="ui-markup"><defs>
    <state name="body" type="string" value="&lt;b&gt;Safe&lt;/b&gt;&lt;script&gt;window.unsafeMarkup = true&lt;/script&gt;"></state>
  </defs><div $html="$body"></div></template>
  <template component="ui-ask" module="./ask.js"><defs>
    <request name="pick" type="string" returns="integer"></request>
    <state name="answer" type="integer" value="0"></state>
  </defs><div><output>{$answer}</output></div></template>
  <template component="ui-script"><defs>
    <state name="loads" type="integer" value="0"></state>
    <handler name="loaded"><set name="loads" expr:value="$loads + 1"></set></handler>
    <script name="sdk" src="/fixture-sdk.js" on:load="loaded"></script>
  </defs><div from:data-loaded="$sdk.ok"><output>{$loads}</output></div></template>
  <template component="ui-scoped"><defs>
    <slot name="row"><prop name="item" type="string" required>Item.</prop><prop name="index" type="integer" required>Position.</prop></slot>
    <state name="rows" type="list(string)" value="['Ada', 'Bea']"></state>
    <state name="divisor" type="integer" value="1"></state>
    <handler name="invalidate"><set name="divisor" expr:value="0"></set></handler>
  </defs><ul on:dblclick="invalidate"><slot name="row" $each="row of $rows" $key="$row" from:item="$row" from:index="$loop.index / $divisor"><li>Missing</li></slot></ul></template>
  <template component="ui-slot-app"><defs><prop name="prefix" type="string" default="Team">Prefix.</prop></defs>
    <nav><ui-scoped><template slot="row"><li><b>{$item}</b><em>{$prefix}</em><small>{$index}</small></li></template></ui-scoped></nav></template>
  <template component="ui-typed" module="./typed.ts"><div></div></template>
  <template component="ui-selected"><defs>
    <prop name="format" type="keyword" values="text, number" default="number">Format.</prop>
    <prop name="answer">Answer.<type from="format"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>
  </defs><div><output>{$answer}</output></div></template>`;


export const angularController = `export function connect(host, { signal }) {
  const inputs = host[Symbol.for("@nextwebwg/html-next.inputs.v1")];
  const source = inputs.source("message");
  source.publish({ value: "Connected", status: { ready: true, pending: false, error: null, stale: false } });
  host.root.dataset.activations = String(Number(host.root.dataset.activations ?? 0) + 1);
  host.effect(() => { host.root.dataset.observed = String(host.state.count); });
  host.on("click", () => { host.state.count += 1; });
  return () => { host.root.dataset.disconnected = String(signal.aborted); };
}`;

export const angularRequestController = `export async function connect(host) {
  host.state.answer = await host.request("pick", "abc");
}`;

export const angularTypedController = `import "./setup.ts";
export function connect(host: { root: HTMLElement }): void {
  host.root.dataset.sideEffect = (globalThis as unknown as { angularSideEffect?: string }).angularSideEffect ?? "missing";
}`;
export const angularSetup = `(globalThis as unknown as { angularSideEffect?: string }).angularSideEffect = "kept";
export {};`;
