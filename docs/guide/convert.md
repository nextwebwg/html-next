---
title: Convert to Vue
order: 3
blurb: Vue 3.5 SFCs · library and application modes
eyebrow: HTML Next · Tools
---

# Convert to Vue

Convert a component graph into Vue 3.5 single-file components that import only Vue.

## Convert a graph

```bash
npm install --save-dev @nextwebwg/html-next-converter@next
html-next-convert vue components/button.html components/card.html --mode library --out-dir generated
```

Each `.vue` file imports only Vue, the components it nests, and its own controller, which is copied beside it. Props, state, computed values, bindings, structural directives, slots, events, and methods map to Vue's own features, and styles become `<style scoped>`.

| Mode | Emits |
| --- | --- |
| `--mode application` | An `application.ts` entry for the graph's roots. |
| `--mode library` | An `index.ts` entry whose named exports can be consumed independently. |

Both modes write `html-next.conversion.json`, which records the inputs, the entry, every artifact, and the target version.

## Publish the output

Publish the `.vue` files together with the `.js` and `.d.ts` files your Vue build produces from them, for example with `vite build` and `@vitejs/plugin-vue`, and `vue-tsc --declaration --emitDeclarationOnly`.

## Diagnostics

| Code | Meaning |
| --- | --- |
| `HTC001` | A definition is invalid, or uses a construct the Vue conversion does not map yet. |
| `HTC002` | Two generated files would share a path; nothing is written. |
| `HTC003` | The target version is not supported; the graph is not loaded. |

> [!note] Other frameworks
> React conversion is in development. Svelte is not supported.
