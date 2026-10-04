---
title: Usage
order: 1
navGroup: guide
blurb: HTML Next · Vue · React
eyebrow: HTML Next · Usage
---

# Use HTML Next components

Choose a framework in any section. Every selector on this page follows your choice, so the setup and examples stay together.

## Install

Start with a Vite project and use Node 22 or 24. The plugin supports Vite 8.

```bash
npm install --save-dev @nextwebwg/html-next-unplugin
```

::: framework-html-next

The native build creates ordinary DOM elements.

:::

::: framework-vue

Keep your project's usual Vue plugin. The current target is Vue 3.5.

:::

::: framework-react

Keep your project's usual React plugin. The current target is React 19.3.

:::

::: framework-svelte

The Svelte adapter is coming soon. You can write the HTML definition now; use HTML Next, Vue, or React to run it today.

:::

## Configure Vite {#vite}

::: framework-html-next

```ts title="vite.config.ts"
import { defineConfig } from "vite";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ entries: ["src/counter.html"] })],
});
```

:::

::: framework-vue

```ts title="vite.config.ts"
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ target: "vue" }), vue()],
});
```

:::

::: framework-react

```ts title="vite.config.ts"
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ target: "react" }), react()],
});
```

:::

::: framework-svelte

Svelte Vite configuration will be available when the adapter ships. Choose another target for a working setup.

:::

## Use your component

::: framework-html-next

Save the [component you built](/html-next/quick-start) as `src/counter.html`.

```js title="src/main.js"
import { createXCounter } from "virtual:html-next/components";

document.getElementById("app").append(createXCounter());
```

```html title="index.html"
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>HTML Next counter</title></head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
```

Run your project's usual `npm run dev` command. Click the counter and Reset. Vite builds the HTML definition into JavaScript that creates native DOM elements; a production build does not parse component definitions in the browser.

:::

::: framework-vue

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

:::

::: framework-react

Save the [component you built](/html-next/quick-start) as `src/counter.html`, then import it alongside your existing React components:

```tsx title="App.tsx"
import { XCounter } from "./counter.html";

export default function App() {
  return <XCounter />;
}
```

The result uses React and native DOM roots. Generated components import the helpers their features need and have no HTML Next runtime dependency. Editing the HTML definition updates the component in your app.

:::

::: framework-svelte

The Svelte adapter is coming soon. The HTML definition stays the same; Svelte import and rendering instructions will follow with the adapter.

:::

## Typecheck

::: framework-html-next

Use your project's usual tools to check application code. A JavaScript app needs no additional typecheck setup.

:::

::: framework-vue

Enable `allowArbitraryExtensions` in your TypeScript configuration. The adapter writes adjacent `.d.html.ts` declarations for local imports. Generate them before a standalone typecheck:

```json title="package.json"
{
  "scripts": {
    "typecheck": "html-next-sync && vue-tsc --noEmit"
  }
}
```

If a component needs declarations before its first import, add `entries: ["src/counter.html"]` to `htmlNext({ target: "vue" })`.

:::

::: framework-react

Enable `allowArbitraryExtensions` in your TypeScript configuration. The adapter writes adjacent `.d.html.ts` declarations for local imports. Generate them before a standalone typecheck:

```json title="package.json"
{
  "scripts": {
    "typecheck": "html-next-sync && tsc --noEmit"
  }
}
```

If a component needs declarations before its first import, add `entries: ["src/counter.html"]` to `htmlNext({ target: "react" })`.

:::

::: framework-svelte

Svelte typechecking instructions will come with the adapter.

:::

## Use a library {#use-a-library}

With the Vite plugin configured, install the library named in its README:

```bash
npm install your-library
```

::: framework-html-next

Add `htmlNext()` to your Vite plugins, using the same import shown above. Installed libraries are discovered automatically; you do not need to list their HTML files in `entries`.

Import the factory named in the library's README:

```js
import { createUiButton } from "your-library";

document.getElementById("app").append(createUiButton());
```

Here `your-library` and `createUiButton` are examples; use the package and component names your library documents.

:::

::: framework-vue

```js
import { UiButton } from "your-library";
```

Use those exports like other Vue components. The names come from the library's README. Include the generated `src/html-next.d.ts` in your TypeScript project to get its component types.

:::

::: framework-react

```js
import { UiButton } from "your-library";
```

Use those exports like other React components. The names come from the library's README. Include the generated `src/html-next.d.ts` in your TypeScript project to get its component types.

:::

::: framework-svelte

Publishers can already package their HTML source. Consuming it in Svelte will be available when the adapter ships.

:::

## Use it without a build step {#browser-runtime}

::: framework-html-next

Save `counter.html` beside this page. The module script loads the definition and renders each `<x-counter>` instance:

```html title="index.html — browser runtime"
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>HTML Next counter</title>
    <script type="module" src="https://cdn.jsdelivr.net/npm/@nextwebwg/html-next/dist/browser.js"></script>
    <link rel="component" href="./counter.html">
  </head>
  <body><x-counter></x-counter></body>
</html>
```

Serve these files over HTTP. The runtime handles updates and components added to the page later. With a bundler, importing `@nextwebwg/html-next/browser` starts the same runtime.

### Browser support {#browser-support}

The live runtime needs native CSS `@scope`: Chrome 118, Safari 17.4, Firefox 146, or later. Vite output uses attribute-based style scoping for older browsers.

### Loading and trust

Same-origin component links work directly. Loading a component root from another origin requires an import-map entry. Controllers are ordinary trusted JavaScript; browser CORS and CSP rules apply. See the proposal's [resource loading rules](/declarative-components/security).

:::

::: framework-vue

For Vue, use the Vite adapter above. Choose HTML Next in this section for the direct browser-runtime setup.

:::

::: framework-react

For React, use the Vite adapter above. Choose HTML Next in this section for the direct browser-runtime setup.

:::

::: framework-svelte

The Svelte adapter is coming soon. Choose HTML Next in this section to run the definition directly in a browser today.

:::

## When you need more

- [Ship a library](/html-next/ship) when other projects need your components.
- Use the [CLI reference](https://github.com/nextwebwg/html-next#inspect-and-build-a-graph) to check definitions or build without Vite.
- See the [Vite plugin reference](https://github.com/nextwebwg/html-next/tree/main/packages/html-next-unplugin) for libraries, externally defined custom elements, and build limits. Compiled component invocations currently need to be empty and statically placed; unsupported features fail with a source-located diagnostic.
