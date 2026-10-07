# `@nextwebwg/html-next-unplugin`

Vite can convert imported Declarative Components sources into Vue, React, or Svelte components. Libraries
publish their HTML definitions; consumers use their normal component imports.

## Framework source imports

```ts
// vite.config.ts — Vue
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ target: "vue" }), vue()],
});
```

For React, use `target: "react"` with `@vitejs/plugin-react` in place of the Vue plugin.
For Svelte 5, use its standard Vite compiler after the converter:

```ts
// vite.config.ts — Svelte
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ target: "svelte" }), svelte()],
});
```

The adapter discovers installed dependencies that declare the `html-next` export condition,
converts their source entry points, and generates framework declarations. No `entries` list
or component-name mapping is needed for those packages.

```ts
import { Button } from "@some/library";
```

## Publish an HTML source library

The recommended distribution is your HTML files and Vite-plugin instructions. No author build
script or generated index is required. Point the `html-next` export at your component folder:

```json
{
  "name": "your-library",
  "version": "1.0.0",
  "type": "module",
  "files": ["components"],
  "exports": { ".": { "html-next": "./components/" } }
}
```

The adapter includes `.html` resources in that folder and nested folders. Each definition gets a
named framework export: `<template component="ui-button">` becomes `UiButton`. Native consumers
import `createUiButton` with `htmlNext()`; Vite discovers installed source libraries automatically.
Use `npm pack` to test the published files, then publish with npm. Include linked definitions and
controllers in `files`, preserving relative paths; declare controllers' external dependencies in
the package manifest. The [publishing guide](https://nextwebwg.org/html-next/ship) covers the README
and consumption instructions.

Explicit subpaths can point to another component folder or directly to an HTML file. Only
concrete `html-next` export conditions opt into conversion; wildcard exports are not discovered.
The folder scan does not follow symlinks. For Vue and React, an authored JS/TS barrel can supply
aliases instead of exposing every component in a folder:

```json
{ "exports": { ".": { "html-next": "./components/index.js" } } }
```

```js
// components/index.js
export { UiButton as Button, UiDialog as Dialog } from "./controls.html";
```

A multi-component HTML resource exposes a named export for each definition, with no default export.
The framework adapters preserve authored aliases. Existing `assembleComponentPackage` outputs keep
working; assembly is optional for source libraries.

### Generated types

The adapter uses `vue-tsc`, TypeScript, or `svelte2tsx` to emit declarations from the converted components.
These retain required props, allowed values, dependent prop types, and framework slot APIs.
Runtime source and declarations live under `node_modules/.html-next/<target>/`.
`src/html-next.d.ts` exposes the package's exports to the consumer's editor and typechecker.
Include that file in your TypeScript project; `declarationsFile` can change its location.
Generated files may be gitignored. Existing authored declaration files are never overwritten.

Vite prepares these files automatically at startup and during builds. Before standalone
`tsc` or `vue-tsc` runs, prepare them using the same Vite configuration:

```json
{
  "scripts": {
    "typecheck": "html-next-sync && vue-tsc --noEmit"
  }
}
```

For React, replace `vue-tsc` with `tsc`; for Svelte, use `svelte-check`. `html-next-sync` loads your Vite config; you do not
repeat the target or package list. An API is also available:

```ts
import { syncHtmlNext } from "@nextwebwg/html-next-unplugin";
await syncHtmlNext({ target: "vue", root: process.cwd() });
```

Unchanged generated sources reuse cached declarations. Edits to authored sources regenerate
components and types; the dev server reloads consumers. This first adapter supports Vite,
explicit package exports, and relative source-barrel imports. Non-Vite adapters retain their
native build mode. Framework conversion reports unsupported constructs as build errors.

### Local HTML resources

```ts
import { UiButton, UiDialog } from "./controls.html";
```

Local imports are converted on demand and receive a generated `controls.d.html.ts` beside the
source. Enable TypeScript's `allowArbitraryExtensions` for these imports. To prepare local types
before any runtime import, configure `entries: ["src/controls.html"]` with the framework target.
`?raw` and `?url` imports keep Vite's normal behavior. Use `publicRootURL` when definitions contain
component-relative data URLs. The adapter supplies `parse5` for converted `$html` helpers.

## Native builds

**Beats Solid, Svelte, Vue, and React in js-framework-benchmark.** The native build also produces a **23% smaller benchmark bundle than Svelte**. [Results and methodology](https://nextwebwg.org/html-next/performance).

Build integration for a closed Declarative Components application or library graph. The plugin
parses component sources during the build, emits native DOM factories, combines the graph's support
imports through the bundler, and writes `html-next.manifest.json` with the component and capability
inventory.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({
    entries: ["src/components/app.html"],
    mode: "application",
    experimentalDirectExtend: true,
  })],
});
```

```ts
import { createApp } from "virtual:html-next/components";

document.body.append(createApp());
```

`experimentalDirectExtend: true` enables direct DOM generation for supported components, as used in the benchmark. The manifest’s `directExtend` field records whether it applies and which components use runtime fallbacks.

In application mode, the virtual module exports one `create<Name>` function for each component declared in the configured
application entries. A linked `<link rel="component">` dependency used as an empty custom-element
invocation is compiled to a call to that dependency's native factory rather than an inert unknown
element. Transitive factories remain internal to the application graph.

Library mode gives each configured public entry a stable, independently consumable virtual module:

```ts
// vite.config.ts
htmlNext({
  entries: ["src/components/card.html", "src/components/button.html"],
  mode: "library",
});
```

```js
export { createXCard } from "virtual:html-next/components/x-card";
```

Generated factories import runtime helpers through one `virtual:html-next/support` module. Its
graph-wide capability union and concrete package imports are recorded in
`html-next.manifest.json`, together with the public entries and direct component edges. Component
source parsing stays in the build process and is absent from browser output.

An unlinked custom-element invocation is rejected as an undeclared dynamic boundary. Applications
that intentionally delegate a tag to a separately delivered custom element must say so explicitly:

```ts
htmlNext({
  entries: ["src/components/app.html"],
  dynamicBoundaries: [
    { tag: "x-external-chart", strategy: "external-custom-element" },
  ],
});
```

The external element remains a native `document.createElement()` boundary and is listed with its
users in the manifest. Capability chunks and the universal HTML Next runtime are not yet dynamic
boundary strategies.

The current compiled-invocation tranche accepts empty, statically positioned invocations in
components that do not need the general runtime renderer. Attributes, projected children, events,
refs, structural flow, invocation cycles, and general-runtime parents fail before emission with a
source-located `HN` diagnostic rather than producing a partially valid graph.
