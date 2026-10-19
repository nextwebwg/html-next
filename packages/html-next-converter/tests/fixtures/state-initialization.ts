export const stateInitializationFiles = {
  "parent.html": `<link rel="component" href="./child.html"><link rel="component" href="./local.html"><link rel="component" href="./selected.html"><template component="x-seed" module="./parent.js"><defs>
    <prop name="product" type="object({ name: string })">Product.</prop><prop name="driven" type="string">Saved.</prop>
    <state name="draft" type="object({ name: string })" from="$product"></state>
    <state name="early" from="$product.name"></state>
    <state name="same" from="$product.name"></state>
    <state name="forward" type="string" from="$later"></state><state name="later" type="string" from="$product.name"></state>
    <handler name="edit"><set name="draft.name" expr:value="concat($product.name, '!')"></set></handler>
    <computed name="label" type="string" from="$draft.name"></computed></defs>
    <section><template $await="binding of $draft"><h2>{$draft.name}</h2><input class="draft" bind:value="$draft.name"></template>
    <p $error="problem">{$problem.message}</p><i $else>Waiting.</i><input class="early" bind:value="$early">
    <span class="early-state" $await="$early">Early ready.</span><span $error>Early failed.</span><span $else>Early waiting.</span>
    <b class="forward">{$forward}</b><b class="driven">{$driven}</b><button on:click="edit">Edit</button><x-seed-child from:product="$draft"></x-seed-child><x-local-seed></x-local-seed><x-selected-seed from:value="7"></x-selected-seed></section></template>`,
  "child.html": `<template component="x-seed-child" module="./child.js"><defs><prop name="product" type="object({ name: string })">Product.</prop>
    <context name="draft" from="x-seed" as="parentDraft"></context><state name="contextDraft" type="string" from="$parentDraft.name"></state><computed name="label" type="string" from="$parentDraft.name"></computed></defs>
    <article><span class="context" $await="$parentDraft">{$parentDraft.name}</span><em $error="problem">{$problem.message}</em><u $else>Context waiting.</u>
    <span class="child" $await="$product">{$product.name}</span><s $error>Unavailable.</s><s $else>Child waiting.</s><small $await="$label">{$label}</small><small $error>Label unavailable.</small>
    <b class="context-draft" $await="$contextDraft">{$contextDraft}</b><b $error>Draft unavailable.</b></article></template>`,
  "local.html": `<template component="x-local-seed"><defs><state name="text" type="string" from="'Local'"></state></defs><output class="local">{$text}</output></template>`,
  "selected.html": `<template component="x-selected-seed"><defs><prop name="value">Value.<type from="mode"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop>
    <context name="draft" from="x-seed" as="parentDraft"></context><state name="mode" type="keyword" values="text, number" from="$parentDraft.name != '' ? 'number' : 'text'"></state></defs>
    <aside><output class="selected" $await="$mode">{$value}</output><output $error>Unavailable.</output></aside></template>`,
  "parent.js": `import { bindModule } from "@nextwebwg/html-next/bindings";
    if (typeof window === "undefined") throw new Error("Browser module imported during SSR");
    export const { connect } = bindModule({ props: { driven: { input: (_props, { state }) => state.label, load: value => {
      (window.reads ||= []).push(value); return value;
    } } }, connect(host, context) { window.activations = (window.activations || 0) + 1; window.activation = context.signal; window.host = host; window.port = Reflect.get(host, Symbol.for("@nextwebwg/html-next.inputs.v1")); window.source = window.port.source("product"); } });`,
  "child.js": `export function connect(host) { window.childPort = Reflect.get(host, Symbol.for("@nextwebwg/html-next.inputs.v1")); }`,
};
