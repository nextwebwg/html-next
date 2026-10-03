---
title: Get started
order: 0
navGroup: guide
blurb: write a component · run it · choose a target
eyebrow: HTML Next · Get started
---

# Your first HTML Next component

Write a reactive counter in HTML, then choose how your project will run it.

## Write the component

Save this as `counter.html`. It declares state, a click handler, and one native button as its root.

```html title="counter.html"
<template component="x-counter">
  <defs>
    <state name="count" type="number" value="0"></state>
    <handler name="increment">
      <set name="count" expr:value="count + 1"></set>
    </handler>
  </defs>
  <button type="button" on:click="increment">
    Count: <span $value="count"></span>
  </button>
</template>
```

`$value` connects the span to `count`. The handler updates that state when the button is clicked. The rendered root is the button itself.

Add a `<style>` inside the definition when it needs scoped CSS. An optional `controller="./counter.js"` connects an ordinary ES module for imperative behavior. Start with the markup and add JavaScript where you need it.

## Run it in an HTML page

Save an `index.html` beside the component:

```html title="index.html"
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>My first HTML Next component</title>
    <script type="module" src="https://cdn.jsdelivr.net/npm/@nextwebwg/html-next/dist/browser.js"></script>
    <link rel="component" href="./counter.html">
  </head>
  <body>
    <x-counter></x-counter>
  </body>
</html>
```

Serve the directory over HTTP with your usual development server, then open the page and click the button. Use a current browser with native CSS `@scope`; the [runtime guide](/html-next/runtime#browser-support) lists the supported versions.

## Use it in your project

| Project | Next step |
| --- | --- |
| Vue or React with Vite | [Add the adapter](/html-next/frameworks) and import `{ XCounter }` from `./counter.html`. |
| HTML page | [Use the live runtime](/html-next/runtime), from a CDN or an installed package. |
| Native DOM application | [Compile a graph](/html-next/build) with Vite. |
| Framework source output | [Convert components](/html-next/convert) to `.vue` or `.tsx` files. |
| Reusable component library | [Ship the sources](/html-next/ship) for consumers to adapt to their framework. |

Vue and React adapters and converters are available today. Svelte support is coming soon; it is not an installable target yet.

## Keep learning

The [component model](/declarative-components/components), [bindings](/declarative-components/bindings), [reactivity](/declarative-components/reactivity), and [styles](/declarative-components/styling) are defined in the proposal. Use those chapters as the full authoring reference; use these guides for installation, integration, and distribution.
