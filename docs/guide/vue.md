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

Use Node 22 or 24 and Vite 8. The current target is Vue 3.5.

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

## Use a library or publish your own

Installed HTML Next source libraries keep their public imports, such as `import { Button } from "@example/ui"`. The adapter discovers the package's `html-next` export; include its generated `src/html-next.d.ts` in your TypeScript project. The package name here is illustrative.

[Source library packaging](/html-next/convert#source-libraries) explains that format. For a library that ships ready-built native, Vue, and React entries, follow [Ship for Vue and React](/html-next/ship-frameworks). If you want to generate Vue source files separately, use the [Converter](/html-next/convert). Unsupported component features produce build errors; see the [adapter reference](https://github.com/nextwebwg/html-next/tree/main/packages/html-next-unplugin#vue-and-react-source-imports) for current coverage.
