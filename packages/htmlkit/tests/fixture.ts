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
  await write(root, "app/layouts/default.html", `<template component="app-layout"><title>Application default</title><meta name="description" from:content="brand"><defs>
    <prop name="brand" type="string" required>Brand</prop></defs>
    <main><header $value="brand"></header><slot name="page"></slot></main>
    <style>:host { color: rgb(20, 30, 40); background-image: url('./texture.svg'); }</style></template>`);
  await write(root, "app/layouts/texture.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><!--' + 'asset'.repeat(1000) + '--><rect width="1" height="1" fill="white"/></svg>');
  await write(root, "app/layouts/default.server.ts", `export function load() {
    return { props: { brand: 'HTMLKit' }, data: { owner: 'kit' }, head: { title: 'Application' } };
  }`);
  await write(root, "app/pages/index.html", `<meta name="htmlkit:page" content="home-page">
    <template component="home-button"><defs><prop name="count" type="number" default="0">Count</prop></defs><button type="button"><slot></slot><span $value="count"></span></button></template>
    <template component="home-label"><strong>Shared-file helper</strong><style>:host { color: rgb(90, 80, 70); }</style></template>
    <template component="home-page" controller="./home.js"><meta name="description" from:content="asset"><defs>
    <prop name="asset" type="string" required>Asset URL</prop>
    <state name="count" type="number" value="0"></state>
    <state name="text" type="string" value="initial"></state>
    <data name="result" src="./data.json"></data></defs>
    <section><h1>Home</h1><home-label></home-label><img from:src="asset" alt="Mark"><home-button $ref="button" from:count="count" from:aria-expanded="count > 4" class:active="count > 4" style:opacity="count > 4 ? '0.5' : '1'">Next</home-button>
      <output $value="count"></output><input bind:value="text"><p $if="result.pending">Loading data</p>
      <p $if="result.ok" $value="result.value.label"></p></section><style>:host { border-color: rgb(10, 20, 30); }</style></template>`);
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
    return { props: { asset: base + 'mark.svg' }, state: { count: 4 }, head: { title: 'Home & kit' } };
  }`);
  await write(root, "app/layouts/items.html", `<template component="items-layout"><defs><prop name="brand" type="string" required>Brand</prop></defs><main><header $value="brand"></header><article><h2>Items</h2><slot name="page"></slot></article></main><style>:host { color: rgb(20, 30, 40); }</style></template>`);
  await write(root, "app/layouts/items.server.ts", `export const load = () => ({ props: { brand: "HTMLKit" }, data: { owner: "kit" } });`);
  await write(root, "app/pages/items/[slug].html", `<template component="item-page"><meta name="htmlkit:layout" content="items"><defs>
    <prop name="label" type="string" required>Label</prop>
    <prop name="tags" type="list(string)" required>Tags</prop></defs>
    <section><h1 $value="label"></h1><p $each="tag of tags" $value="tag"></p></section></template>`);
  await write(root, "app/pages/items/[slug].server.ts", `export const entries = () => [{ slug: 'one' }, { slug: 'two' }];
    export function load({ params, parent }) {
      return { props: { label: parent.owner + ': ' + params.slug, tags: ['a < b', 'quote " here'] },
        head: { title: params.slug } };
    }`);
  await write(root, "public/mark.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>');
  return root;
}
