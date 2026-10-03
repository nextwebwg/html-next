---
title: Run in the browser
order: 2
blurb: one script · trust · browser support
eyebrow: HTML Next · Browser runtime
---

# Run in the browser

Add one script to the page, and every component it links loads, renders, and updates, with no build step.

## Add it to the page

[Create a definition](/html-next/quick-start) first, or use a library's concrete HTML resource.

One script in the `<head>` is the whole setup. It starts on its own, loads the components the page links, and renders every instance, including ones added later.

```html
<head>
  <script type="module" src="https://cdn.jsdelivr.net/npm/@nextwebwg/html-next/dist/browser.js"></script>
  <link rel="component" href="/components/app.html">
</head>
<body>
  <x-app></x-app>
</body>
```

With a bundler, import the same entry once:

```js
import "@nextwebwg/html-next/browser";
```

Each definition declares its own component and controller dependencies, and the runtime follows them. Instances are cleaned up when they leave the document. `HTMLNext.ready` resolves once the page's linked components have loaded.

## Trust

The page's own links and import map decide which components load. A same-origin `href` needs nothing else; a component root on another origin needs an import-map entry. Relative component and controller paths must stay inside their root, and definitions are parsed as inert HTML that cannot add import maps, scripts, base URLs, or policy metadata.

Controllers are trusted JavaScript in the page's realm. ES modules, CORS, and CSP govern how they load, but a module is not a sandbox.

## Build-time graphs

A compiled build imports `@nextwebwg/html-next/runtime`, the renderer without the component parser; see [Compile a graph](/html-next/build).

## Browser support {#browser-support}

The live runtime needs native CSS `@scope`: Chrome 118, Safari 17.4, Firefox 146, or later. Compiled output keeps attribute-based scoping for older browsers.

| Surface | How the runtime provides it |
| --- | --- |
| Discovery and lifecycle | One shared `MutationObserver` finds registered tags and balances connect and disconnect cleanup. |
| Parsing | The browser's HTML parser builds the inert DOM; the library reads and validates the declarations. |
| Reactivity | Native events and microtasks drive state, computed values, bindings, and effects. |
| Dynamic `$html` | A deterministic sanitizer applies the proposal's safe-default content policy across browsers and SSR. |
| Scoped styles | Native `@scope`, with selectors rewritten for nested components and projected content. |
| Keyed lists | `moveBefore()` keeps element identity where available, with an `insertBefore()` fallback in WebKit. |

## Authoring reference

See the proposal for [components](/declarative-components/components), [reactivity](/declarative-components/reactivity), and [resource loading and trust](/declarative-components/security). To use framework components instead, follow the [Vue and React guide](/html-next/frameworks).
