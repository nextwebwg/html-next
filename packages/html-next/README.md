<div align="center">

# HTML Next

### Universal components. Built with HTML.

Author once. Use native DOM, Vue, React, or Svelte.

[**Get started →**](https://nextwebwg.org/html-next/quick-start) · [Documentation](https://nextwebwg.org/html-next/)

[![npm](https://img.shields.io/npm/v/@nextwebwg/html-next?color=245c4f&label=npm)](https://www.npmjs.com/package/@nextwebwg/html-next)
[![MIT license](https://img.shields.io/badge/license-MIT-245c4f)](https://github.com/nextwebwg/html-next/blob/main/LICENSE)

</div>

---

## Write HTML. Keep your options.

HTML Next brings markup, state, events, slots, and scoped styles together in one component file. Build native DOM with Vite, load components directly in a browser, or generate Vue, React, and Svelte components.

```html
<template component="x-counter">
  <defs>
    <state name="count" type="number" value="0"></state>
    <handler name="increment">
      <set name="count" expr:value="$count + 1"></set>
    </handler>
  </defs>
  <button type="button" on:click="increment">
    Count: {$count}
  </button>
</template>
```

**One source file. Four ways to use it.** [Build your first component →](https://nextwebwg.org/html-next/quick-start)

## Get started

For a native Vite application:

```sh
npm install --save-dev @nextwebwg/html-next-unplugin
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({
    entries: ["src/app.html"],
    experimentalDirectExtend: true,
  })],
});
```

The benchmark uses `experimentalDirectExtend: true`. This enables direct DOM generation for supported components; the build manifest reports where it applies. [Finish the Vite setup →](https://nextwebwg.org/html-next/usage)

For the browser runtime, server rendering, or component tooling:

```sh
npm install @nextwebwg/html-next
```

| Use it your way | Start here |
| --- | --- |
| **Native DOM** · Build a Vite application | [Native setup](https://nextwebwg.org/html-next/usage) |
| **No build step** · Load HTML definitions in the browser | [Browser runtime](https://nextwebwg.org/html-next/usage#browser-runtime) |
| **Vue, React, or Svelte** · Import the same HTML component | [Vue](https://nextwebwg.org/html-next/usage/vue) · [React](https://nextwebwg.org/html-next/usage/react) · [Svelte](https://nextwebwg.org/html-next/usage/svelte) |
| **Component libraries** · Share your HTML sources | [Publish a library](https://nextwebwg.org/html-next/ship) |
| **Framework source** · Generate components ahead of time | [Converter](https://nextwebwg.org/html-next/convert) |

## Package entry points

| Import | Purpose |
| --- | --- |
| `@nextwebwg/html-next` | Parse, inspect, and compile component definitions. |
| `@nextwebwg/html-next/runtime` | Render already parsed definitions without the component parser. |
| `@nextwebwg/html-next/live` | Runtime plus parsing for definitions authored in a document. |
| `@nextwebwg/html-next/browser` | Start the live runtime automatically. |
| `@nextwebwg/html-next/server` | Render in Node and hydrate in the browser. |
| `@nextwebwg/html-next/forms` | Build native form requests with validation, encoding, and cancellation. |
| `@nextwebwg/html-next/validation` | Use the shared validity model. |

Importing `forms` pulls in no component runtime. Generated native components import the helpers their features need; generated Vue, React, and Svelte components use their target framework without an HTML Next runtime dependency.

## Built in the open

HTML Next implements the [Declarative HTML Components](https://nextwebwg.org/declarative-components/) and [HTML Forms](https://nextwebwg.org/html-forms/) proposals. The tools are available today as alpha releases. The proposals are at Stage 0; syntax and generated output may change.

[Documentation](https://nextwebwg.org/html-next/) · [Source](https://github.com/nextwebwg/html-next) · [Report an issue](https://github.com/nextwebwg/html-next/issues) · [MIT license](https://github.com/nextwebwg/html-next/blob/main/LICENSE)
