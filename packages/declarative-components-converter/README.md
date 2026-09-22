# `@nextwebwg/declarative-components-converter`

Converts a Declarative Components application or library graph into Vue 3.5 single-file components.
Once converted, HTML Next is gone: each `.vue` file imports only Vue, the components it nests, and
its own controller, which is copied beside it. Props, state, computed values, bindings, structural
directives, slots, events, and methods map to Vue's own facilities, and styles become
`<style scoped>`.

```sh
html-next-convert vue components/button.html components/card.html --mode library --out-dir generated
```

Application conversion emits an `application.ts` entry for the selected graph roots. Library
conversion emits an `index.ts` entry whose named exports are independently consumable. Both modes
emit `html-next.conversion.json`, which records the input entries, output entry, every artifact, and
the target version.

Publish the `.vue` files together with the `.js` and `.d.ts` your Vue build produces from them
(for example `vite build` with `@vitejs/plugin-vue`, and `vue-tsc --declaration --emitDeclarationOnly`).

A construct Vue conversion does not map yet, or an invalid definition, produces the source-located
`HTC001` diagnostic with the underlying code. Colliding generated paths produce `HTC002` before any
output is written, and an unsupported target version produces `HTC003` before the graph is loaded.

React is in development. Svelte is not supported.
