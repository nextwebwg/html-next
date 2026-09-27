---
title: Run in the browser
order: 1
blurb: live loader · trust · entry points
eyebrow: HTML Next · Tools
---

# Run in the browser

The live runtime loads, parses, and runs any component graph in the page, with no build step.

## Load a component graph

The application names the root component and maps where its components live. Each definition declares its own component and controller dependencies, and the loader follows them.

```html
<script type="importmap">
{
  "imports": {
    "@example/components/": "https://cdn.example/components/"
  }
}
</script>
<link rel="component" href="@example/components/app.html">
<x-app></x-app>

<script type="module">
  import { startBrowserComponents } from "@nextwebwg/html-next/browser-loader";
  await startBrowserComponents();
</script>
```

`startBrowserComponents()` observes the document: definitions and instances added later are registered and rendered, and cleanup runs when they disconnect.

## Trust

The application's import map is the trust decision. Relative component and controller paths must stay inside the component root it maps. Definitions are parsed as inert HTML and cannot add import maps, scripts, base URLs, or policy metadata.

Controllers are trusted JavaScript in the page's realm. ES modules, CORS, and CSP govern how they load, but a module is not a sandbox.

## Entry points

| Import | Contains |
| --- | --- |
| `@nextwebwg/html-next/browser-loader` | `startBrowserComponents()`: the loader, parser, and runtime together. |
| `@nextwebwg/html-next/live` | The runtime plus the parser, for calling `lowerDocument()` or `observeDocument()` yourself. |
| `@nextwebwg/html-next/runtime` | The renderer without a parser, for definitions already parsed at build time. |

Reading a definition from the document without the parser reports the `HR007` diagnostic instead of doing nothing.

## Browser support

The live runtime needs native CSS `@scope`: Chrome 118, Safari 17.4, Firefox 146, or later. Compiled output keeps attribute-based scoping for older browsers.

| Surface | How the runtime provides it |
| --- | --- |
| Discovery and lifecycle | One shared `MutationObserver` finds registered tags and balances connect and disconnect cleanup. |
| Parsing | The browser's HTML parser builds the inert DOM; the library reads and validates the declarations. |
| Reactivity | Native events and microtasks drive state, computed values, bindings, and effects. |
| Dynamic `$html` | A small DOM sanitizer applies the proposal's content policy until native `setHTML()` is available everywhere. |
| Scoped styles | Native `@scope`, with selectors rewritten for nested components and projected content. |
| Keyed lists | `moveBefore()` keeps element identity where available, with an `insertBefore()` fallback in WebKit. |
