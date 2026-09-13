# `@nextwebwg/declarative-components-unplugin`

Build integration for a closed Declarative Components application or library graph. The plugin
parses component sources during the build, emits native DOM factories, combines the graph's support
imports through the bundler, and writes `html-next.manifest.json` with the component and capability
inventory.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import htmlNext from "@nextwebwg/declarative-components-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({
    entries: ["src/components/app.html"],
    mode: "application",
  })],
});
```

```ts
import { createApp } from "virtual:html-next/components";

document.body.append(createApp());
```

In application mode, the virtual module exports one `create<Name>` function for each configured
application entry. A linked `<link rel="component">` dependency used as an empty custom-element
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
