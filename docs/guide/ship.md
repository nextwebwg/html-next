---
title: Ship a library
order: 5
blurb: source packages · framework output · package exports
eyebrow: HTML Next · Distribution
---

# One library. More than one framework.

Publish your component definitions once, or ship generated framework entries alongside them. Vue and React consumers can use the same authored components; Svelte support is coming soon.

## Choose your distribution

| Distribution | What you publish | What the consumer needs |
| --- | --- | --- |
| HTML source library | Definitions, controllers, and source exports | [Vue or React Vite adapter](/html-next/frameworks), or the live runtime for concrete HTML resources |
| Preconverted library | Generated Vue or React components, JavaScript, types, and CSS | The matching framework and normal build tooling |
| Native DOM library | [Compiled native entries](/html-next/build) and required support | A JavaScript bundler |

## Publish an HTML source library

Install the tools for packaging:

```bash
npm install --save-dev @nextwebwg/html-next
```

Use the package assembler to preserve the HTML and controller graph and expose the source condition the adapters discover:

```js title="build-library.mjs"
import { assembleComponentPackage } from "@nextwebwg/html-next";

await assembleComponentPackage({
  name: "@example/ui",
  version: "0.1.0",
  outDirectory: "package",
  sourceOnly: true,
  components: [{ source: "components/counter.html" }],
});
```

Run `node build-library.mjs`, review the generated package, set your own license and metadata, and verify its contents with `npm pack --dry-run` from the `package` directory before publishing. Include controllers' external dependencies in the package manifest.

A consumer with the Vite adapter installed can then write:

```ts
import { XCounter } from "@example/ui";
```

Use your own package name in place of `@example/ui`. The adapter generates Vue or React components and their declarations from the published source.

## Give exports familiar names

A hand-authored source barrel can alias the carrier's export:

```js title="components/index.js"
export { XCounter as Counter } from "./counter.html";
```

Expose it with the package's `html-next` export condition:

```json title="package.json — source export"
{
  "exports": {
    ".": { "html-next": "./components/index.js" }
  },
  "files": ["components"]
}
```

That is a source-export excerpt, not a complete package manifest. Include every linked definition and controller in the published files. HTML resources have named exports, not default exports.

## Ship framework output ahead of time

[Convert the library](/html-next/convert) separately for Vue and React. Expose the built results through `./vue` and `./react` package subpaths, or publish the generated source entries if consumers will build them.

Use the conversion inventories to carry required dependencies and framework peers into `package.json`. When framework subpaths are independently usable, their peers can be optional. Publish CSS with the components. Individual component subpaths allow consumers to avoid unused components and their CSS; a shared barrel may retain CSS side effects.

## Verify it as a consumer

Pack the package and install the tarball in a fresh consumer project. Check the public imports, declarations, styles, controller dependencies, and a production build for each target you advertise. The [repository's installed-library test](https://github.com/nextwebwg/html-next/blob/main/packages/html-next-converter/tests/library-distribution.test.ts) exercises this pattern for Vue and React.

The [proposal's targets chapter](/declarative-components/targets) describes the language's delivery model. This guide describes the package shapes the current tools emit.
