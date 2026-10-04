---
title: Converter
order: 2
blurb: generate framework source · inspect conversion output
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

A directory such as `components/` is also accepted, as are explicit `.html` files. Definitions keep their source-directory layout beneath the target folder. Export names use PascalCase derived from component tags; each definition in a multi-component HTML file gets its own export.

| Target | Component output | Styles |
| --- | --- | --- |
| Vue 3.5 | `.vue` single-file components | `<style scoped>` |
| React 19.3 | `.tsx` components | Adjacent imported `.css` files |
| Svelte | Coming soon | Planned; not emitted today |

The generated files use Vue or React directly and have no HTML Next runtime dependency. The converter also copies controllers and writes the small helper files each component needs.

If a component uses `$html` to render an HTML string, its generated code needs the `parse5` package. Install the dependencies listed under `package.dependencies` in `html-next.conversion.json`; components without `$html` do not need `parse5`.

## Choose the output shape

| Mode | Entry |
| --- | --- |
| `--mode application` | `<target>/application.ts`, exporting the application entry components |
| `--mode library` | `<target>/index.ts`, with independently consumable named exports |

Both modes write `html-next.conversion.json` with the inputs, artifacts, target version, and required package dependencies and peers. If a `<data src>` URL is component-relative, pass `--public-root-url /app/` when the conversion root is served at `/app/`.

## Package the results

[Ship for Vue and React](/html-next/ship-frameworks) shows a complete library build: convert both targets automatically, compile their JavaScript and types, publish their CSS, and expose Vue and React entries from one package.

## Prefer conversion during the app build?

Use the [Usage guide](/html-next/usage). It converts local imports and installed source libraries on demand and prepares their types.

## Publish HTML instead {#source-libraries}

For most component libraries, [publish your HTML files](/html-next/ship) and give consumers the Vite-plugin instructions. Each app builds the same package for native HTML Next, Vue, or React. You do not need a library build script.

## Diagnostics

| Code | Meaning |
| --- | --- |
| `HTC001` | An invalid definition or a construct the selected target cannot map |
| `HTC002` | Generated output paths collide |
| `HTC003` | The requested target version is unsupported |

Unsupported constructs fail explicitly. The [proposal](/declarative-components/) defines the component language; the [converter documentation](https://github.com/nextwebwg/html-next/tree/main/packages/html-next-converter) describes the implementation's current coverage.
