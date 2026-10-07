---
title: Usage · Vue
eyebrow: HTML Next · Usage
---

# Use HTML Next components in Vue

Import HTML component definitions into your existing Vue app. The Vite adapter generates Vue components as you develop and build.

## Install

In a Vite project with its usual Vue plugin already configured:

```bash
npm install --save-dev @nextwebwg/html-next-unplugin
```

Use Node 22.22.2+ or 24.15+ and Vite 8. The current target is Vue 3.5.

## Configure Vite

```ts title="vite.config.ts"
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ target: "vue" }), vue()],
});
```

## Use your component

Save the [component you built](/html-next/quick-start) as `src/counter.html`, then import it alongside your existing Vue components:

```html title="App.vue"
<script setup lang="ts">
import { XCounter } from "./counter.html";
</script>

<template>
  <XCounter />
</template>
```

The result uses Vue and native DOM roots. Generated components import the helpers their features need and have no HTML Next runtime dependency. Editing the HTML definition updates the component in your app.

## Typecheck

Enable `allowArbitraryExtensions` in your TypeScript configuration. The adapter writes adjacent `.d.html.ts` declarations for local imports. Generate them before a standalone typecheck:

```json title="package.json"
{
  "scripts": {
    "typecheck": "html-next-sync && vue-tsc --noEmit"
  }
}
```

If a component needs declarations before its first import, add `entries: ["src/counter.html"]` to `htmlNext({ target: "vue" })`.

## Use a library

With the plugin configured above, install an HTML Next library and import its components:

```bash
npm install your-library
```

```js
import { UiButton } from "your-library";
```

Use those exports like other Vue components. The names come from the library's README. Include the generated `src/html-next.d.ts` in your TypeScript project to get its component types.

## Publish your own

We recommend [publishing your HTML files](/html-next/ship) with these Vite-plugin instructions. Apps choose their framework when they build. You can also [publish prebuilt Vue and React entries](/html-next/ship-frameworks) when consumers cannot use the plugin, or use the [Converter](/html-next/convert) to generate framework source separately.

Unsupported component features produce build errors; see the [adapter reference](https://github.com/nextwebwg/html-next/tree/main/packages/html-next-unplugin#vue-and-react-source-imports) for current coverage.
