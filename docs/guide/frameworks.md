---
title: Vue & React
order: 1
navGroup: guide
blurb: Vite adapters · local imports · generated types
eyebrow: HTML Next · Frameworks
---

# Use HTML components in Vue and React

Keep your framework and its usual component imports. Let the Vite adapter turn HTML Next definitions into components for your project.

## Framework support

| Framework | Vite adapter | Converter | Output |
| --- | --- | --- | --- |
| Vue | Available | Available | Vue 3.5 single-file components |
| React | Available | Available | React 19.3 TSX and CSS |
| Svelte | Coming soon | Coming soon | Planned; not shipped yet |

The adapters convert sources during development and builds. The [converter](/html-next/convert) writes framework source ahead of time. Both use the same HTML component definitions.

## Install the adapter

In an existing Vite project, install the adapter alongside your normal framework plugin:

```bash
npm install --save-dev @nextwebwg/html-next-unplugin
```

Use Node 22 or 24 and a compatible Vite project; the current adapter has a Vite 8 peer range.

## Vue {#vue}

```ts title="vite.config.ts"
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ target: "vue" }), vue()],
});
```

Import the component from the [counter definition](/html-next/quick-start):

```html title="App.vue"
<script setup lang="ts">
import { XCounter } from "./counter.html";
</script>

<template>
  <XCounter />
</template>
```

## React {#react}

```ts title="vite.config.ts"
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ target: "react" }), react()],
});
```

```tsx title="App.tsx"
import { XCounter } from "./counter.html";

export default function App() {
  return <XCounter />;
}
```

Both targets produce framework components with native roots. Generated components use their framework and the emitted helpers their features require, with no HTML Next runtime dependency.

## Use a component library

The adapter also discovers installed packages that expose an `html-next` source export. Their public aliases stay the same:

```ts
import { Button } from "@example/ui";
```

That package name is illustrative: install an HTML Next source library before importing it. See [Ship a library](/html-next/ship) to publish this package shape.

## Types and development

Local `.html` imports get an adjacent `.d.html.ts` declaration. Enable `allowArbitraryExtensions` in your TypeScript configuration. For package imports, include the generated `src/html-next.d.ts` in your project.

Vite generates declarations at startup and build time. If a standalone typecheck runs first, prepare them with the same Vite configuration:

```json title="package.json — Vue"
{
  "scripts": {
    "typecheck": "html-next-sync && vue-tsc --noEmit"
  }
}
```

For React, use `html-next-sync && tsc --noEmit`. To prepare a local component before the first import, add `entries: ["src/counter.html"]` to `htmlNext({ target: "vue" })` or its React equivalent. Source edits regenerate output and reload the consuming app.

> [!note] Svelte is next
> Svelte Vite adapters and conversion are coming soon. There is no Svelte target to install today. Use the live runtime, native build, Vue, or React in the meantime.

## Conversion boundaries

The tools report unsupported constructs as build errors rather than silently changing a component. They convert HTML Next definitions to framework source; they do not convert existing Vue or React components back into HTML Next.

For the complete source-import contract, see the [adapter documentation](https://github.com/nextwebwg/html-next/tree/main/packages/html-next-unplugin#vue-and-react-source-imports). For component syntax, follow the [authoring reference](/declarative-components/overview).
