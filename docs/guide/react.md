---
title: Usage · React
eyebrow: HTML Next · Usage
---

# Use HTML Next components in React

Import HTML component definitions into your existing React app. The Vite adapter generates React components as you develop and build.

## Install

In a Vite project with its usual React plugin already configured:

```bash
npm install --save-dev @nextwebwg/html-next-unplugin
```

Use Node 22 or 24 and Vite 8. The current target is React 19.3.

## Configure Vite

```ts title="vite.config.ts"
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ target: "react" }), react()],
});
```

## Use your component

Save the [component you built](/html-next/quick-start) as `src/counter.html`, then import it alongside your existing React components:

```tsx title="App.tsx"
import { XCounter } from "./counter.html";

export default function App() {
  return <XCounter />;
}
```

The result uses React and native DOM roots. Generated components import the helpers their features need and have no HTML Next runtime dependency. Editing the HTML definition updates the component in your app.

## Typecheck

Enable `allowArbitraryExtensions` in your TypeScript configuration. The adapter writes adjacent `.d.html.ts` declarations for local imports. Generate them before a standalone typecheck:

```json title="package.json"
{
  "scripts": {
    "typecheck": "html-next-sync && tsc --noEmit"
  }
}
```

If a component needs declarations before its first import, add `entries: ["src/counter.html"]` to `htmlNext({ target: "react" })`.

## Use a library

With the plugin configured above, install an HTML Next library and import its components:

```bash
npm install your-library
```

```js
import { UiButton } from "your-library";
```

Use those exports like other React components. The names come from the library's README. Include the generated `src/html-next.d.ts` in your TypeScript project to get its component types.

## Publish your own

We recommend [publishing your HTML files](/html-next/ship) with these Vite-plugin instructions. Apps choose their framework when they build. You can also [publish prebuilt Vue and React entries](/html-next/ship-frameworks) when consumers cannot use the plugin, or use the [Converter](/html-next/convert) to generate framework source separately.

Unsupported component features produce build errors; see the [adapter reference](https://github.com/nextwebwg/html-next/tree/main/packages/html-next-unplugin#vue-and-react-source-imports) for current coverage.
