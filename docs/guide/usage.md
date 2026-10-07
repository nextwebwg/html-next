---
title: Usage
order: 1
navGroup: guide
blurb: HTML Next · Vue · React · Svelte
eyebrow: HTML Next · Usage
---

# Use HTML Next components

Choose a framework in any section. Every selector on this page follows your choice, so the setup and examples stay together.

## Install

Start with a Vite project and use Node 22.22.2+ or 24.15+. The plugin supports Vite 8.

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

Keep your project's usual Svelte plugin. The current target is Svelte 5.57.1. The adapter uses the standard, unpatched framework; see the [known keyed-focus limitation](/html-next/convert).

:::

## Configure Vite {#vite}

::: framework-html-next

```ts title="vite.config.ts"
import { defineConfig } from "vite";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ entries: ["src/app.html"] })],
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

```ts title="vite.config.ts"
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ target: "svelte" }), svelte()],
});
```

:::

## Use your component

Build a small workshop check-in app: count guests as they arrive, then reset for the next session. Each example uses the same counter inside an `App` component and shows how to attach that app to the page. In an existing Vue, React, or Svelte project, keep its mounting code and add the counter to its `App` component.

::: framework-html-next

Save the [counter you built](/html-next/quick-start) as `src/counter.html`. Use it inside the app:

```html title="src/app.html"
<link rel="component" href="./counter.html">

<template component="x-app">
  <main>
    <h1>Workshop check-in</h1>
    <p>Count guests as they arrive. Reset for the next session.</p>
    <x-counter></x-counter>
  </main>
</template>
```

Attach the app to the page:

```js title="src/main.js"
import { createXApp } from "virtual:html-next/components";

document.getElementById("app").append(createXApp());
```

```html title="index.html"
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Workshop check-in</title></head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
```

Run your project's usual `npm run dev` command. Click the counter and Reset. Vite builds the HTML definition into JavaScript that creates native DOM elements; a production build does not parse component definitions in the browser. Each component becomes a cloned template plus the exact DOM updates its features need, with the same behavior as the browser runtime. [How builds compile components](/html-next/performance#compiled-output) explains more.

:::

::: framework-vue

Save the [counter you built](/html-next/quick-start) as `src/counter.html`. Use it inside the app:

```html title="src/App.vue"
<script setup lang="ts">
import { XCounter } from "./counter.html";
</script>

<template>
  <main>
    <h1>Workshop check-in</h1>
    <p>Count guests as they arrive. Reset for the next session.</p>
    <XCounter />
  </main>
</template>
```

Attach `App` to the page:

```ts title="src/main.ts"
import { createApp } from "vue";
import App from "./App.vue";

createApp(App).mount("#app");
```

```html title="index.html"
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Workshop check-in</title></head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Run your project's usual `npm run dev` command. Click the counter and Reset.

The result uses Vue and native DOM roots. Generated components import the helpers their features need and have no HTML Next runtime dependency. Editing the HTML definition updates the component in your app.

:::

::: framework-react

Save the [counter you built](/html-next/quick-start) as `src/counter.html`. Use it inside the app:

```tsx title="src/App.tsx"
import { XCounter } from "./counter.html";

export default function App() {
  return (
    <main>
      <h1>Workshop check-in</h1>
      <p>Count guests as they arrive. Reset for the next session.</p>
      <XCounter />
    </main>
  );
}
```

Attach `App` to the page:

```tsx title="src/main.tsx"
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("app")!).render(<App />);
```

```html title="index.html"
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Workshop check-in</title></head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Run your project's usual `npm run dev` command. Click the counter and Reset.

The result uses React and native DOM roots. Generated components import the helpers their features need and have no HTML Next runtime dependency. Editing the HTML definition updates the component in your app.

:::

::: framework-svelte

Save the [counter you built](/html-next/quick-start) as `src/counter.html`. Use it inside the app:

```svelte title="src/App.svelte"
<script lang="ts">
  import { XCounter } from "./counter.html";
</script>

<main>
  <h1>Workshop check-in</h1>
  <p>Count guests as they arrive. Reset for the next session.</p>
  <XCounter />
</main>
```

Attach `App` to the page:

```ts title="src/main.ts"
import { mount } from "svelte";
import App from "./App.svelte";

mount(App, { target: document.getElementById("app")! });
```

```html title="index.html"
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Workshop check-in</title></head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Run your project's usual `npm run dev` command. Click the counter and Reset.

The result uses Svelte and native DOM roots. Generated components import the helpers their features need and have no HTML Next runtime dependency. Editing the HTML definition updates the component in your app.

:::

## Typecheck

::: framework-html-next

Run `html-next-check` to check components without building. It reports invalid declarations, constraints, and component links with their file and line. Pass the same entries as your Vite configuration:

```json title="package.json"
{
  "scripts": {
    "check": "html-next-check src/app.html"
  }
}
```

Check controllers and other application code with your project's usual tools, such as `tsc --noEmit`.

:::

::: framework-vue

Enable `allowArbitraryExtensions` in your TypeScript configuration. The adapter writes adjacent `.d.html.ts` declarations for local imports. Check components with `html-next-check`, then generate declarations before a standalone typecheck:

```json title="package.json"
{
  "scripts": {
    "typecheck": "html-next-check --target vue src/counter.html && html-next-sync && vue-tsc --noEmit"
  }
}
```

If a component needs declarations before its first import, add `entries: ["src/counter.html"]` to `htmlNext({ target: "vue" })`.

:::

::: framework-react

Enable `allowArbitraryExtensions` in your TypeScript configuration. The adapter writes adjacent `.d.html.ts` declarations for local imports. Check components with `html-next-check`, then generate declarations before a standalone typecheck:

```json title="package.json"
{
  "scripts": {
    "typecheck": "html-next-check --target react src/counter.html && html-next-sync && tsc --noEmit"
  }
}
```

If a component needs declarations before its first import, add `entries: ["src/counter.html"]` to `htmlNext({ target: "react" })`.

:::

::: framework-svelte

Enable `allowArbitraryExtensions` in your TypeScript configuration. The adapter writes adjacent `.d.html.ts` declarations for local imports. Check components with `html-next-check`, then generate declarations before a standalone typecheck:

```json title="package.json"
{
  "scripts": {
    "typecheck": "html-next-check --target svelte src/counter.html && html-next-sync && svelte-check"
  }
}
```

If a component needs declarations before its first import, add `entries: ["src/counter.html"]` to `htmlNext({ target: "svelte" })`.

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

```js
import { UiButton } from "your-library";
```

Use those exports like other Svelte components. The names come from the library's README. Include the generated `src/html-next.d.ts` in your TypeScript project to get its component types.

:::

## Use it without a build step {#browser-runtime}

::: framework-html-next

Save the `app.html` and `counter.html` files from above beside this page. The module script loads the app and its counter, then renders the `<x-app>` instance:

```html title="index.html — browser runtime"
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Workshop check-in</title>
    <script type="module" src="https://cdn.jsdelivr.net/npm/@nextwebwg/html-next/dist/browser.js"></script>
    <link rel="component" href="./app.html">
  </head>
  <body><x-app></x-app></body>
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

For Svelte, use the Vite adapter above. Choose HTML Next in this section for the direct browser-runtime setup.

:::

## When you need more

- [Ship a library](/html-next/ship) when other projects need your components.
- Use the [CLI reference](https://github.com/nextwebwg/html-next#inspect-and-build-a-graph) to check definitions or build without Vite.
- See the [Vite plugin reference](https://github.com/nextwebwg/html-next/tree/main/packages/html-next-unplugin) for libraries, externally defined custom elements, and build limits.
