---
title: Compile a graph
order: 2
blurb: CLI · Vite plugin · manifest
eyebrow: HTML Next · Tools
---

# Compile a graph

Compile a known component graph ahead of time into native DOM, with only the runtime support that graph uses.

## The command line

The `html-next` command reads component HTML and static imports without running controllers.

```bash
html-next check components/app.html
html-next inspect components/app.html
html-next build components/app.html --out-dir generated
html-next build components/app.html --out-dir generated --target vue --target styles
```

`check` validates the graph, and `inspect` reports its component, controller, and module edges. `build` emits deterministic artifacts plus `html.manifest.json`, an inventory of what was built. Generated output keeps each definition's own root element and adds no wrapper.

## Vite

`@nextwebwg/html-next-unplugin` compiles the graph during a Vite build.

```bash
npm install --save-dev @nextwebwg/html-next-unplugin@next
```

```ts title="vite.config.ts"
import { defineConfig } from "vite";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({
    entries: ["src/components/app.html"],
    mode: "application",
  })],
});
```

In application mode, the virtual module exports one `create<Name>` function per entry:

```ts
import { createApp } from "virtual:html-next/components";

document.body.append(createApp());
```

Library mode gives each entry its own module, so consumers import only the components they use:

```js
export { createXCard } from "virtual:html-next/components/x-card";
```

The build writes `html-next.manifest.json` with the entries, component edges, and the runtime support the graph needs. The component parser stays in the build and is absent from browser output.

## External custom elements

A custom-element tag that no definition links is rejected, so a typo cannot silently render an unknown element. Declare tags that another script defines:

```ts
htmlNext({
  entries: ["src/components/app.html"],
  dynamicBoundaries: [
    { tag: "x-external-chart", strategy: "external-custom-element" },
  ],
});
```

> [!warn] Current limits
> Compiled component invocations must be empty and statically placed. Attributes, projected children, events, refs, and structural directives on an invocation fail with a source-located `HN` diagnostic rather than producing a partial build.
