---
title: Usage
order: 1
navGroup: guide
blurb: HTML Next · Vue · React
eyebrow: HTML Next · Usage
---

# Use HTML Next components

Run your components natively with Vite, or load them directly in an HTML page. Choose Vue or React above to use the same definitions in those frameworks.

## Use HTML Next natively with Vite {#vite}

Start with a Vite project and save the [component you built](/html-next/quick-start) as `src/counter.html`.

### Install

```bash
npm install --save-dev @nextwebwg/html-next-unplugin
```

Use Node 22 or 24. The current plugin supports Vite 8.

### Configure Vite

```ts title="vite.config.ts"
import { defineConfig } from "vite";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ entries: ["src/counter.html"] })],
});
```

### Render the component

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

## Use a library {#use-a-library}

Install the library and the Vite plugin:

```bash
npm install your-library
npm install --save-dev @nextwebwg/html-next-unplugin
```

Add `htmlNext()` to your Vite plugins, using the same import shown above. Installed libraries are discovered automatically; you do not need to list their HTML files in `entries`.

Import the factory named in the library's README:

```js
import { createUiButton } from "your-library";

document.getElementById("app").append(createUiButton());
```

Here `your-library` and `createUiButton` are examples; use the package and component names your library documents.

## Use it without a build step {#browser-runtime}

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

## When you need more

- [Ship a library](/html-next/ship) when other projects need your components.
- Use the [CLI reference](https://github.com/nextwebwg/html-next#inspect-and-build-a-graph) to check definitions or build without Vite.
- See the [Vite plugin reference](https://github.com/nextwebwg/html-next/tree/main/packages/html-next-unplugin) for libraries, externally defined custom elements, and build limits. Compiled component invocations currently need to be empty and statically placed; unsupported features fail with a source-located diagnostic.
