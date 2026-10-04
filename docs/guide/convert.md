---
title: Convert to frameworks
order: 3
blurb: Vue · React · Svelte · library and application modes
eyebrow: HTML Next · Tools
---

# Convert to frameworks

Convert a component graph into Vue 3.5 or Svelte 5 single-file components, or React 19.3 TSX components. Generated output imports its framework, authored modules, and only the feature helpers it needs; it has no HTML Next runtime dependency.

## Convert a graph

```bash
npm install --save-dev @nextwebwg/html-next-converter
html-next-convert vue 'components/**' --mode library --out-dir generated/vue-target
html-next-convert react 'components/**' --mode library --out-dir generated/react-target
html-next-convert svelte 'components/**' --mode library --out-dir generated/svelte-target
```

Quote the glob so the converter expands it. Source directories are preserved under the framework output directory. Each component imports its nested components and controller, which is copied beside it. Props, state, computed values, bindings, structural directives, slots, and methods use the target's facilities; declared events remain native DOM events. Vue styles become `<style scoped>`; React and Svelte import adjacent CSS.

| Mode | Emits |
| --- | --- |
| `--mode application` | An `application.ts` entry for the graph's roots. |
| `--mode library` | An `index.ts` entry whose named exports can be consumed independently. |

Both modes write `html-next.conversion.json`, which records the inputs, the entry, every artifact, the target version, and package dependencies and peer dependencies. Merge its `package` fields into the published package manifest. Application entries and library entries export components; the consumer mounts or hydrates them using its framework.

## Publish the output

Publish generated source with the components, CSS, controllers, and feature helpers, or compile it to JavaScript and declarations with the standard framework pipeline. Vue uses `@vitejs/plugin-vue` and `vue-tsc`; React uses its normal TSX tooling; Svelte uses `@sveltejs/vite-plugin-svelte`, `svelte-check` for source checks, and `svelte2tsx` for declaration emission. Give each target a separate output directory and package subpath. Framework peers may be optional when those subpaths are independently consumable.

For source-only libraries, the [Vite adapter](https://github.com/nextwebwg/html-next/tree/main/packages/html-next-unplugin#framework-source-imports) can convert installed HTML exports on demand and generate consumer types.

## Diagnostics

| Code | Meaning |
| --- | --- |
| `HTC001` | A definition is invalid, or uses a construct the selected target cannot represent. |
| `HTC002` | Two generated files would share a path; nothing is written. |
| `HTC003` | The target version is not supported; the graph is not loaded. |

The [converter guide](https://github.com/nextwebwg/html-next/tree/main/packages/html-next-converter) describes target baselines, dependency metadata, source imports, and independently consumable component subpaths.
