import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export async function write(root: string, file: string, contents: string): Promise<void> {
  const path = join(root, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

export async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "htmlkit-app-"));
  await write(root, "package.json", '{"name":"htmlkit-fixture","private":true,"type":"module"}');
  await write(root, "app/layouts/default.html", `<template component="app-layout"><defs>
    <prop name="brand" type="string" required>Brand</prop><title>Application</title><meta name="description" from:content="$brand"></defs>
    <main><header>{$brand}</header><slot name="page"></slot></main>
    <style>:host { color: rgb(20, 30, 40); background-image: url('./texture.svg'); }</style></template>`);
  await write(root, "app/layouts/texture.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><!--' + 'asset'.repeat(1000) + '--><rect width="1" height="1" fill="white"/></svg>');
  await write(root, "app/layouts/default.server.ts", `export function load() {
    return { props: { brand: 'HTMLKit' }, data: { owner: 'kit' } };
  }`);
  await write(root, "app/pages/index.html", `<meta name="hk:page" content="home-page">
    <template component="home-button"><defs><prop name="count" type="number" default="0">Count</prop></defs><button type="button"><slot></slot><span>{$count}</span></button></template>
    <template component="home-label"><strong>Shared-file helper</strong><style>:host { color: rgb(90, 80, 70); }</style></template>
    <template component="home-page" controller="./home.js"><defs>
    <prop name="asset" type="string" required>Asset URL</prop>
    <state name="count" type="number" value="0"></state>
    <state name="text" type="string" value="initial"></state>
    <data name="result" src="./data.json"></data><title>Home &amp; kit</title><meta name="description" from:content="$asset"></defs>
    <section><h1>Home</h1><home-label></home-label><img from:src="$asset" alt="Mark"><home-button $ref="button" from:count="$count" from:aria-expanded="$count > 4" class:active="$count > 4" style:opacity="$count > 4 ? '0.5' : '1'">Next</home-button>
      <output>{$count}</output><input bind:value="text"><p $if="$result.pending">Loading data</p>
      <p $if="$result.ok">{$result.value.label}</p></section><style>:host { border-color: rgb(10, 20, 30); }</style></template>`);
  await write(root, "app/pages/data.json", '{"label":"Loaded data"}');
  await write(root, "app/pages/controller.css", 'button { border: 2px solid rgb(55, 66, 77); }');
  await write(root, "app/pages/home.ts", `import './controller.css'; if (typeof document === 'undefined') throw new Error('Controller ran on server');
    export default function(host) {
      host.root.dataset.production = String(import.meta.env.PROD);
      host.on('connect', () => {
        host.root.dataset.connections = String(Number(host.root.dataset.connections || 0) + 1);
        const click = () => { host.state.count += 1; };
        host.refs.button.addEventListener('click', click);
        return () => host.refs.button.removeEventListener('click', click);
      });
    }`);
  await write(root, "app/pages/index.server.ts", `export function load({ base }) {
    return { props: { asset: base + 'mark.svg' }, state: { count: 4 } };
  }`);
  await write(root, "app/layouts/items.html", `<template component="items-layout"><defs><prop name="brand" type="string" required>Brand</prop></defs><main><header>{$brand}</header><article><h2>Items</h2><slot name="page"></slot></article></main><style>:host { color: rgb(20, 30, 40); }</style></template>`);
  await write(root, "app/layouts/items.server.ts", `export const load = () => ({ props: { brand: "HTMLKit" }, data: { owner: "kit" } });`);
  await write(root, "app/pages/items/[slug].html", `<template component="item-page"><defs>
    <prop name="label" type="string" required>Label</prop>
    <prop name="tags" type="list(string)" required>Tags</prop>
    <prop name="slug" type="string" required>Slug</prop><title>{$slug}</title><meta name="hk:layout" content="items"></defs>
    <section><h1>{$label}</h1><p $each="tag of $tags">{$tag}</p></section></template>`);
  await write(root, "app/pages/items/[slug].server.ts", `export const entries = () => [{ slug: 'one' }, { slug: 'two' }];
    export function load({ params, parent }) {
      return { props: { label: parent.owner + ': ' + params.slug, tags: ['a < b', 'quote " here'], slug: params.slug } };
    }`);
  // Runs during head parsing, before the body exists or anything paints.
  await write(root, "app/head.js", "document.documentElement.dataset.prepaint = String(document.body === null);");
  await write(root, "public/mark.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>');
  return root;
}

/** Ordinary component providers, with an explicit value standing in for one instance's data. */
export async function bindingFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "htmlkit-bindings-"));
  await write(root, "package.json", '{"name":"htmlkit-bindings-fixture","private":true,"type":"module"}');
  await write(root, "app/layouts/default.html", `<template component="binding-shell"><defs>
    <prop name="marker" type="string" default="Shell">Marker.</prop><state name="draft" type="string" from="$marker"></state></defs>
    <div class="shell"><strong class="shell-value">{$marker}</strong><output class="shell-draft">{$draft}</output><slot name="page"></slot></div></template>`);
  await write(root, "app/layouts/default.server.ts", `export const load = ({ url }) => ({ props: { marker: url.pathname.endsWith('/defaults/') ? null : 'First' } });`);
  await write(root, "app/layouts/default.ts", `export const props = { marker: { initial: 'browser', input: () => null,
    load() { (window.defaultReads ||= []).push('shell'); return 'Unexpected shell read'; } } };`);
  await write(root, "app/pages/index.html", `<link rel="component" href="../components/card.html">
    <link rel="component" href="../components/label.html"><link rel="component" href="../components/behavior.html">
    <template component="binding-page">
    <main><binding-card></binding-card><binding-card product="Fixture"></binding-card><binding-label></binding-label><plain-behavior></plain-behavior><a href="./defaults/">Default inputs</a></main></template>`);
  await write(root, "app/pages/defaults.html", `<template component="default-inputs"><defs>
    <prop name="label" type="string" default="Default">Label.</prop>
    <prop name="nullable" type="string">Nullable fixture.</prop><prop name="count" type="number" default="0">Count.</prop>
    <state name="draft" type="string" from="$label"></state></defs>
    <article><h1>{$label}</h1><output class="nullable" $await="$nullable">{$nullable}</output><p $else>Nullable waiting.</p>
    <output class="count">{$count}</output><input bind:value="$draft"><a href="../">Home</a></article></template>`);
  await write(root, "app/pages/defaults.server.ts", 'export const load = () => ({ props: { nullable: null, count: null } });');
  await write(root, "app/pages/defaults.ts", `export const props = Object.fromEntries(['label', 'nullable', 'count'].map(name => [name, {
    initial: 'browser', input: () => null, load() { (window.defaultReads ||= []).push(name); return name === 'count' ? 42 : 'Provider'; }
  }]));`);
  await write(root, "app/components/card.html", `<template component="binding-card"><defs>
    <prop name="product" type="string">Product.</prop>
    <state name="query" type="string" value="A"></state><state name="draft" type="string" from="$product"></state>
    <handler name="next"><set name="query" value="B"></set></handler></defs>
    <article><h2 $await="$product">{$product}</h2><p $else>Waiting.</p>
    <input bind:value="$draft"><button type="button" on:click="next">Next</button></article></template>`);
  await write(root, "app/components/card.ts", `export const props = { product: {
    initial: 'browser', input: (_props, { state }) => state.query,
    load(query) { (window.bindingReads ||= []).push(query); return 'Product ' + query; }
  } };
  export function connect(host) {
    host.root.dataset.connections = String(Number(host.root.dataset.connections || 0) + 1);
    return () => { host.root.dataset.stops = String(Number(host.root.dataset.stops || 0) + 1); };
  }`);
  await write(root, "app/components/label.html", `<template component="binding-label"><defs><prop name="label" type="string">Label.</prop></defs>
    <aside><output $await="$label">{$label}</output><p $else>Label waiting.</p></aside></template>`);
  await write(root, "app/components/label.js", `export const props = { label: { initial: 'browser', input: () => null, load: () => 'Label only' } };`);
  await write(root, "app/components/behavior.html", '<template component="plain-behavior"><footer>Behavior only</footer></template>');
  await write(root, "app/components/behavior.js", 'export function connect(host) { host.root.dataset.plain = "connected"; }');
  return root;
}

/** Shared providers prepare through the same typed component contract in build, request and browser phases. */
export async function universalFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "htmlkit-universal-"));
  await write(root, "package.json", '{"name":"htmlkit-universal-fixture","private":true,"type":"module"}');
  for (const [file, tag, settings] of [["index", "universal-page", ""], ["fixture", "universal-fixture", ""],
    ["live", "universal-live", '<meta name="hk:render" content="server">'], ["delegated", "universal-delegated", ""], ["deferred", "universal-deferred", ""]]) {
    const rootTag = file === "delegated" ? "universal-shell" : "main";
    await write(root, `app/pages/${file}.html`, `<link rel="component" href="../components/browser-only.html"><link rel="component" href="../components/details.html">
      ${file === "delegated" ? '<link rel="component" href="../components/shell.html">' : ""}
      <template component="${tag}" module="./${file === "deferred" ? "deferred" : "index"}.ts"><defs><meta name="hk:layout" content="none">${settings}
      <prop name="product" type="object({ name: string })" required>Product.</prop>
      <state name="query" type="string" value="A"></state><state name="draft" type="string" from="$product.name"></state>
      <handler name="next"><set name="query" value="B"></set></handler><title>Product {$product.name}</title></defs>
      <${rootTag}><template $await="$product"><h1>{$product.name}</h1>
      <product-details from:product-name="$product.name"></product-details></template><p class="error" $error="problem">{$problem.message}</p><p $else>Waiting.</p>
      <input bind:value="$draft"><button type="button" on:click="next">Next</button><browser-only-node></browser-only-node>
      <a href="/">Home</a><a href="/fixture/">Fixture</a><a href="/live/">Live</a></${rootTag}></template>`);
  }
  await write(root, "app/pages/index.ts", 'export * from "@/lib/provider-entry.ts";');
  await write(root, "app/pages/deferred.ts", `import { create as common } from './index.ts';
    export function create() {
      const definition = common();
      return { ...definition, props: { product: { ...definition.props.product, initial: 'browser',
        async load(...args) {
          if (window.holdUniversal) await new Promise(resolve => { window.releaseUniversal = resolve; });
          return definition.props.product.load(...args);
        }
      } } };
    }`);
  await write(root, "lib/provider-entry.ts", 'export * from "./provider-cycle.ts";');
  await write(root, "lib/provider-cycle.ts", 'export * from "./provider-entry.ts"; export { create } from "./product.ts";');
  await write(root, "lib/product.ts", `export function create() {
    return { props: { product: { keepPrevious: true, input: (_props, { state }) => state.query, async load(query, { phase, signal }) {
      signal.throwIfAborted(); await Promise.resolve();
      if (phase === 'browser') (window.universalReads ||= []).push(query);
      if (query === 'bad') throw new Error('Unavailable product');
      return { name: phase + ':' + query };
    } } }, connect(host) { host.root.dataset.connections = String(Number(host.root.dataset.connections || 0) + 1); window.universalConnections = (window.universalConnections || 0) + 1; } };
  }`);
  await write(root, "app/pages/fixture.server.ts", 'export const load = () => ({ props: { product: { name: "Fixture" } } });');
  await write(root, "app/pages/live.server.ts", 'export const load = ({ url }) => ({ state: { query: url.searchParams.get("q") ?? "A" } });');
  await write(root, "app/components/browser-only.html", '<template component="browser-only-node"><aside>Browser behavior</aside></template>');
  await write(root, "node_modules/@example/browser-only/package.json", '{"name":"@example/browser-only","type":"module","exports":{".":{"browser":"./browser.js"}}}');
  await write(root, "node_modules/@example/browser-only/browser.js", 'export const doc = document;');
  await write(root, "app/components/browser-only.ts", 'import { doc } from "@example/browser-only"; export type props = { label: string }; export type { props as create }; export default function create() { return doc; } export function connect(host) { host.root.dataset.browser = doc === host.root.ownerDocument ? "connected" : "wrong"; }');
  await write(root, "app/components/shell.html", '<template component="universal-shell"><defs><prop name="label" type="string">Label.</prop></defs><main><strong class="shell-label" $await="$label">{$label}</strong><slot></slot></main></template>');
  await write(root, "app/components/shell.ts", 'export const props = { label: { input: () => null, load: (_, { phase }) => phase + ":shell" } };');
  await write(root, "app/components/details.html", `<template component="product-details"><defs>
    <prop name="productName" type="string" required>Product name.</prop><prop name="details" type="string" required>Details.</prop>
    <state name="draft" type="string" from="$details"></state></defs><aside>
    <p class="details" $await="$details">{$details}</p><p $else>Loading details.</p><output class="details-draft">{$draft}</output></aside></template>`);
  await write(root, "app/components/details.ts", `export const props = { details: {
    input: ({ productName }) => productName,
    async load(name, { phase }) {
      await Promise.resolve();
      if (phase === 'browser') (window.detailReads ||= []).push(name);
      return phase + ':details:' + name;
    }
  } };`);
  return root;
}

/** Browser-only companion modules share public selectors without entering server evaluation. */
export async function environmentFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "htmlkit-environments-"));
  await write(root, "package.json", '{"name":"htmlkit-environments-fixture","private":true,"type":"module"}');
  await write(root, "node_modules/@example/browser-only/package.json", '{"name":"@example/browser-only","type":"module","exports":{".":{"browser":"./browser.js"}}}');
  await write(root, "node_modules/@example/browser-only/browser.js", 'export const doc = document; export const marker = "CLIENT_GRAPH_ONLY";');
  for (const [file, tag, module, settings] of [["index", "client-page", "", ""], ["only", "client-only-page", "", ""],
    ["mixed", "mixed-page", "", ""], ["fixture", "client-fixture-page", ' module="./index.ts"', ""],
    ["live", "client-live-page", ' module="./index.ts"', '<meta name="hk:render" content="server">']]) {
    await write(root, `app/pages/${file}.html`, `<template component="${tag}"${module}><defs><meta name="hk:layout" content="none">${settings}
      <prop name="label" type="string" required>Label.</prop><state name="query" type="string" value="A"></state>
      <state name="draft" type="string" from="$label"></state><handler name="next"><set name="query" value="B"></set></handler></defs>
      <main><h1 $await="$label">{$label}</h1><p $error="problem">{$problem.message}</p><p $else>Waiting.</p>
      <input bind:value="$draft"><button type="button" on:click="next">Next</button><a href="/">Home</a><a href="/mixed/">Mixed</a></main></template>`);
  }
  await write(root, "app/pages/index.ts", `export const props = { label: { input: (_, { state }) => state.query } };
    export function connect(host) {
      (window.environmentHooks ||= []).push('common-connect');
      host.root.dataset.commonConnections = String(Number(host.root.dataset.commonConnections || 0) + 1);
      return () => window.environmentHooks.push('common-stop');
    }`);
  await write(root, "app/pages/index.client.ts", `import { doc } from '@example/browser-only';
    export function create() {
      window.environmentCreates = (window.environmentCreates || 0) + 1;
      return { props: { label: { async load(query, { phase }) {
        if (doc !== document) throw new Error('Wrong document');
        (window.environmentReads ||= []).push(query); return phase + ':' + query;
      } } }, connect(host) {
        (window.environmentHooks ||= []).push('client-connect');
        host.root.dataset.clientConnections = String(Number(host.root.dataset.clientConnections || 0) + 1);
        return Promise.resolve(() => window.environmentHooks.push('client-stop'));
      } };
    }`);
  await write(root, "app/pages/only.client.ts", `import { doc } from '@example/browser-only';
    export const props = { label: { input: (_, { state }) => state.query, load: query => doc === document ? 'only:' + query : 'Wrong document' } };`);
  await write(root, "app/pages/mixed.ts", `export const props = { label: { input: (_, { state }) => state.query, load: (query, { phase }) => phase + ':' + query } };`);
  await write(root, "app/pages/mixed.client.ts", `import { marker } from '@example/browser-only';
    export const props = { label: { load: query => { if (!marker) throw new Error('No browser import'); (window.mixedReads ||= []).push(query); return 'client:' + query; } } };
    export function connect(host) { host.root.dataset.mixed = 'connected'; }`);
  await write(root, "app/pages/fixture.server.ts", 'export const load = () => ({ props: { label: "Fixture" } });');
  await write(root, "app/pages/live.server.ts", 'export const load = ({ url }) => ({ state: { query: url.searchParams.get("q") ?? "A" } });');
  return root;
}

/** Private readers use parent-owned services; their common selectors remain universal. */
export async function privateFixture(): Promise<string> {
  const root = await environmentFixture();
  await write(root, "app/pages/index.server.ts", `import { isMainThread } from 'node:worker_threads';
    export const props = { label: { async load(query, context) {
      if (!isMainThread) throw new Error('Private services ran inside a render worker');
      return context.services.read(query, context);
    } } };`);
  return root;
}

/** Both pages retain one layout whose private provider selects a route-supplied typed input. */
export async function retainedProviderFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "htmlkit-retained-provider-"));
  await write(root, "package.json", '{"name":"htmlkit-retained-provider-fixture","private":true,"type":"module"}');
  await write(root, "app/layouts/default.html", `<template component="retained-provider-shell"><defs>
    <prop name="id" type="string" required>Lookup.</prop><prop name="label" type="string" required>Result.</prop>
    <state name="draft" type="string" from="$label"></state></defs><main>
    <h2 $await="$label">{$label}</h2><p $error="problem">{$problem.message}</p><p $else>Waiting.</p>
    <input aria-label="Draft" bind:value="$draft"><button type="button" $ref="refresh">Refresh</button><slot name="page"></slot></main></template>`);
  await write(root, "app/layouts/default.ts", `export function create() {
    if (typeof window !== "undefined") window.retainedCreates = (window.retainedCreates || 0) + 1;
    return { props: { label: { input: ({ id }) => id } }, connect(host, { signal, refresh }) {
      host.root.dataset.connections = String(Number(host.root.dataset.connections || 0) + 1);
      host.refs.refresh.addEventListener("click", () => { void refresh("label"); }, { signal });
    } };
  }`);
  await write(root, "app/layouts/default.server.ts", `export const load = ({ url }) => ({ props: { id: url.pathname.endsWith("/second/") ? "B" : "A" } });
    export const props = { label: { load: (id, context) => context.services.read(id, context) } };`);
  await write(root, "app/pages/index.html", '<template component="retained-first"><article><h1>First</h1><a href="/second/" data-hk-prefetch="none">Second</a><a href="/same/" data-hk-prefetch="none">Same input</a></article></template>');
  await write(root, "app/pages/second.html", '<template component="retained-second"><article><h1>Second</h1><a href="/" data-hk-prefetch="none">First</a></article></template>');
  await write(root, "app/pages/same.html", '<template component="retained-same"><article><h1>Same input</h1><a href="/" data-hk-prefetch="none">First</a></article></template>');
  return root;
}

/** A rendered head's title text, as HTML. */
export function titleOf(page: { readonly head: { readonly html: string } }): string | undefined {
  return /<title[^>]*>([^<]*)<\/title>/.exec(page.head.html)?.[1];
}
