---
title: Converter
order: 2
blurb: generate framework source · inspect conversion output
eyebrow: HTML Next · Conversion
---

# Convert once. Build with your framework.

Turn your HTML component definitions into Vue, React, or Svelte source files that you can inspect, build, and distribute with ordinary framework tooling.

## Install the converter

```bash
npm install --save-dev @nextwebwg/html-next-converter
```

The CLI is `html-next-convert`. The examples below use `npx` to run the installed command. Targets are Vue 3.5, React 19.3, and Svelte 5.57.1.

## Convert a library

Run the command for your target from your project root. Quote the glob so the converter expands it, and use separate output directories to preserve each inventory.

```bash
npx html-next-convert vue 'components/**' --mode library --out-dir generated/vue-target
npx html-next-convert react 'components/**' --mode library --out-dir generated/react-target
npx html-next-convert svelte 'components/**' --mode library --out-dir generated/svelte-target
```

A directory such as `components/` is also accepted, as are explicit `.html` files. Definitions keep their source-directory layout beneath the target folder. Export names use PascalCase derived from component tags; each definition in a multi-component HTML file gets its own export.

| Target | Component output | Styles |
| --- | --- | --- |
| Vue 3.5 | `.vue` single-file components | `<style scoped>` |
| React 19.3 | `.tsx` components | Adjacent imported `.css` files |
| Svelte 5.57.1 | `.svelte` single-file components | Adjacent imported `.css` files |

The generated files use their target framework directly and have no HTML Next runtime dependency. The converter also copies controllers and writes the small helper files each component needs.

If a component uses `$html` to render an HTML string, its generated code needs the `parse5` package. Install the dependencies listed under `package.dependencies` in `html-next.conversion.json`; components without `$html` do not need `parse5`.

## Choose the output shape

| Mode | Entry |
| --- | --- |
| `--mode application` | `<target>/application.ts`, exporting the application entry components |
| `--mode library` | `<target>/index.ts`, with independently consumable named exports |

Both modes write `html-next.conversion.json` with the inputs, entry, artifacts, target version, and required package dependencies and peers. Merge its `package` fields into your published manifest. Entries export components for the consumer to mount or hydrate with its framework. If a `<data src>` URL is component-relative, pass `--public-root-url /app/` when the conversion root is served at `/app/`.

## Package the results

[Ship for Vue and React](/html-next/ship-frameworks) shows a complete library build: convert both targets automatically, compile their JavaScript and types, publish their CSS, and expose native, Vue, and React entries from one package.

Svelte libraries can publish the generated components, CSS, controllers, and helpers as source, or compile them with `@sveltejs/vite-plugin-svelte`, `svelte-check`, and `svelte2tsx`. Give each target its own package subpath; framework peers can be optional when those entries are independently consumable.

## Prefer conversion during the app build?

Use the [Usage guide](/html-next/usage). It converts local imports and installed source libraries on demand and prepares their types.

## Publish source for application-side conversion {#source-libraries}

A source library lets consuming Vue, React, and Svelte apps convert your HTML during their own builds. They use the [HTML Next Vite adapter](https://github.com/nextwebwg/html-next/tree/main/packages/html-next-unplugin#framework-source-imports) rather than prebuilt framework entries. Native users can load the published HTML resources with the [browser runtime](/html-next/usage#browser-runtime).

Install `@nextwebwg/html-next` as a development dependency, then assemble the source package:

```js title="build-source-library.mjs"
import { glob, readFile } from "node:fs/promises";
import { assembleComponentPackage } from "@nextwebwg/html-next";

const metadata = JSON.parse(await readFile("package.json", "utf8"));
const sources = await Array.fromAsync(glob("components/**/*.html"));
await assembleComponentPackage({
  name: metadata.name,
  version: metadata.version,
  outDirectory: "package",
  sourceOnly: true,
  components: sources.map((source) => ({ source })),
});
```

Run `node build-source-library.mjs`. The `package` directory contains your HTML, linked controller modules, and a source entry exposed through the `html-next` package-export condition. The glob includes all HTML definitions under your component folder, so linked definitions are packaged together. Set your license and package metadata, declare controllers' external dependencies, and pack from that directory to test the result before publishing.

In an app configured with the Vue, React, or Svelte adapter, consumers import the library's named component exports from your package name. The adapter finds the published source and converts it for that app. It also generates the framework declarations, as described in [Usage](/html-next/usage).

## Diagnostics

| Code | Meaning |
| --- | --- |
| `HTC001` | An invalid definition or a construct the selected target cannot map |
| `HTC002` | Generated output paths collide |
| `HTC003` | The requested target version is unsupported |

Unsupported constructs fail explicitly. The [proposal](/declarative-components/) defines the component language; the [converter documentation](https://github.com/nextwebwg/html-next/tree/main/packages/html-next-converter) describes the implementation's current coverage.
