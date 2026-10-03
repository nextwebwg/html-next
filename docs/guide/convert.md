---
title: Convert components
order: 4
blurb: Vue and React source · application and library output
eyebrow: HTML Next · Conversion
---

# Convert once. Build with your framework.

Turn your HTML component definitions into Vue or React source files that you can inspect, build, and distribute with ordinary framework tooling.

## Install the converter

```bash
npm install --save-dev @nextwebwg/html-next-converter
```

The CLI is `html-next-convert`. The examples below use `npx` to run the installed command. Vue and React are supported; Svelte conversion is coming soon and is not a CLI target yet.

## Convert a library

Run either command from your project root. Quote the glob so the converter expands it, and use separate output directories to preserve both inventories.

```bash
npx html-next-convert vue 'components/**' --mode library --out-dir generated/vue-target
npx html-next-convert react 'components/**' --mode library --out-dir generated/react-target
```

A directory such as `components/` is also accepted, as are explicit `.html` files. Definitions keep their source-directory layout beneath the target folder. `x-counter` becomes the named export `XCounter`; each carrier in a multi-component HTML file gets its own export.

| Target | Component output | Styles |
| --- | --- | --- |
| Vue 3.5 | `.vue` single-file components | `<style scoped>` |
| React 19.3 | `.tsx` components | Adjacent imported `.css` files |
| Svelte | Coming soon | Planned; not emitted today |

The component files import their framework, nested components, copied controllers, and generated helpers required by their features. They have no HTML Next runtime dependency. A safe-HTML helper can require `parse5`; the inventory records that dependency.

## Choose the output shape

| Mode | Entry |
| --- | --- |
| `--mode application` | `<target>/application.ts`, exporting the graph's roots |
| `--mode library` | `<target>/index.ts`, with independently consumable named exports |

Both modes write `html-next.conversion.json` with the inputs, artifacts, target version, and required package dependencies and peers. If a `<data src>` URL is component-relative, pass `--public-root-url /app/` when the conversion root is served at `/app/`.

## Ship the generated files

Build Vue output with `@vitejs/plugin-vue` and generate types with `vue-tsc`. Build React output with `@vitejs/plugin-react` and TypeScript. Publish the resulting JavaScript, declarations, and CSS; or publish the source for consumers whose bundler handles `.vue` and `.tsx`.

Merge the inventory's `package.dependencies` and `package.peerDependencies` into your package manifest. Declare authored controllers' external dependencies yourself. [Ship a library](/html-next/ship) covers source packages and framework subpaths.

## Prefer conversion during the app build?

Use the [Vue or React Vite adapter](/html-next/frameworks). It converts local imports and installed source libraries on demand and prepares their types.

## Diagnostics

| Code | Meaning |
| --- | --- |
| `HTC001` | An invalid definition or a construct the selected target cannot map |
| `HTC002` | Generated output paths collide |
| `HTC003` | The requested target version is unsupported |

Unsupported constructs fail explicitly. The [proposal](/declarative-components/) defines the component language; the [converter documentation](https://github.com/nextwebwg/html-next/tree/main/packages/html-next-converter) describes the implementation's current coverage.
