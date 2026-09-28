# `@nextwebwg/html-next-converter`

Converts a Declarative Components application or library graph into Vue 3.5 single-file components.
Once converted, HTML Next is gone: each `.vue` file imports Vue, the components it nests, its own
controller (copied beside it), and only the generated helpers its features need. A component using
`$html` imports `vue/html.ts`; that helper requires `parse5` as an application dependency for
deterministic SSR. It parses inert fragments and applies one pinned safe-default allowlist in every
browser and on the server. It deliberately does not call native `setHTML()`, even where available:
Firefox currently parses malformed table content differently from Chromium, WebKit, and `parse5`,
which would make hydration browser-dependent. Props, state, computed values, bindings, structural
directives, slots, and methods map to Vue's own facilities; declared events remain native
`CustomEvent`s on the lowered root (Vue emits are reserved for `v-model` updates), and styles become
`<style scoped>`.

Components declaring props import `vue/props.ts`. It applies HTML Next's typed-value rules before
rendering, including required-prop diagnostics and numeric/boolean attribute conversion; prop-free
components do not include it.

```sh
html-next-convert vue components/button.html components/card.html --mode library --out-dir generated
```

When a `<data src>` URL is relative to its component file, pass `--public-root-url /app/`
if the conversion root is served at `/app/`. The converter uses that URL to preserve
definition-relative requests in the browser. Root-relative and absolute request URLs need no
mapping; a missing mapping for a component-relative URL is a conversion error. The equivalent
JavaScript option is `publicRootURL`.

Application conversion emits an `application.ts` entry for the selected graph roots. Library
conversion emits an `index.ts` entry whose named exports are independently consumable. Both modes
emit `html-next.conversion.json`, which records the input entries, output entry, every artifact, and
the target version.

Publish the `.vue` files together with the `.js` and `.d.ts` your Vue build produces from them
(for example `vite build` with `@vitejs/plugin-vue`, and `vue-tsc --declaration --emitDeclarationOnly`).

Invalid definitions retain HTML Next's source-located `HT` diagnostics. A valid construct that Vue
conversion cannot map produces source-located `HTC001` with the underlying code. Colliding generated
paths produce `HTC002` before any output is written, and an unsupported target version produces
`HTC003` before the graph is loaded.

React is in development. Svelte is not supported.
