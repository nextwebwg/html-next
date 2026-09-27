---
title: Tools
order: -1
blurb: packages · delivery modes · install
eyebrow: HTML Next · Tools
status: 1.0.0-alpha on npm under the `next` tag · Stage 0 proposals
---

# HTML Next tools

JavaScript tools for the HTML Next proposals. Author a component once as HTML, then run it live in the browser, compile it to native DOM, or convert it to Vue.

## Install

```bash
npm install @nextwebwg/html-next@next
```

The packages publish `1.0.0-alpha` prereleases under the `next` tag. The proposals they implement are at Stage 0, so the syntax and the generated output may still change.

## Packages

| Package | What it does |
| --- | --- |
| `@nextwebwg/html-next` | The tools: the live browser runtime, the compiler and CLI, validity on any element, and HTML Forms request construction. |
| `@nextwebwg/html-next-unplugin` | Compiles a component graph in a Vite build. |
| `@nextwebwg/html-next-converter` | Converts a component graph to Vue single-file components. |

## Three ways to deliver a component

The same component definition works in all three modes, with the same observable DOM, state, events, validation, and lifecycle.

| Mode | Use it when | Guide |
| --- | --- | --- |
| Live runtime | Pages load components at runtime, with no build step. | [Run in the browser](/tools/runtime) |
| Compiled build | An application or library has a known component graph and wants tree-shaken native DOM. | [Compile a graph](/tools/build) |
| Vue conversion | A Vue project wants plain Vue components with no HTML Next left in them. | [Convert to Vue](/tools/convert) |

HTML Forms is independent of all three: [its subpath](/tools/forms) works on native forms and imports nothing else.

## A component

A definition declares its public interface, an optional controller, and one root element. The controller is an ordinary ES module.

```html title="counter.html"
<template component="x-counter" controller="./counter.js">
  <defs>
    <prop name="start" type="number" default="0">Initial count.</prop>
    <state name="count" :value="start"></state>
    <computed name="label" :value="format('Count: {0}', count)"></computed>
  </defs>

  <button $ref="button" type="button">
    <span $value="label"></span>
  </button>

  <style>
    button { font: inherit; }
  </style>
</template>
```

```js title="counter.js"
export default function controller({ refs, state }) {
  const increment = () => { state.count += 1; };
  refs.button.addEventListener("click", increment);
  return () => refs.button.removeEventListener("click", increment);
}
```

The complete component language is defined by the [Declarative HTML Components proposal](/html-next/).

## Source

The tools are MIT-licensed and developed in [nextwebwg/html-next](https://github.com/nextwebwg/html-next). [Looma](https://threadlabs.studio/looma/) is a UI library built on them.
