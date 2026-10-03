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

Components declaring props import `vue/props.ts`. Invalid incoming values remain available at
their source while the root reports validity; a later typed binding is checked separately. A
Vue property binding should supply a number or boolean as that type, not as a string. Prop-free
components do not include this helper.

```sh
html-next-convert vue 'components/**' --mode library --out-dir generated
```

Quote the glob so the converter, not your shell, expands it. It discovers every `.html`
component below `components/`, including definitions with no incoming component link, and
preserves the source directory layout beneath `generated/vue/`.
An HTML file may contain several `<template component>` declarations; all are converted and
exported by name. `ui-button` becomes `UiButton`, and no prefix is removed automatically. A directory path such as
`components/` is shorthand for the same recursive scan. Explicit `.html` files remain valid.

When a `<data src>` URL is relative to its component file, pass `--public-root-url /app/`
if the conversion root is served at `/app/`. The converter uses that URL to preserve
definition-relative requests in the browser. Root-relative and absolute request URLs need no
mapping; a missing mapping for a component-relative URL is a conversion error. The equivalent
JavaScript option is `publicRootURL`.

Application conversion emits an `application.ts` entry for the selected graph roots. Library
conversion emits an `index.ts` entry whose named exports are independently consumable. Both modes
emit `html-next.conversion.json`, which records the input entries, output entry, every artifact,
the target version, and package-shaped `dependencies` and `peerDependencies`. Copy the relevant
fields from `package` into the published package's `package.json`. `parse5` appears in
`dependencies` only when an emitted `$html` helper needs it; Vue or React appears in
`peerDependencies` for its respective output. Dependencies imported by authored controller
modules remain the publisher's responsibility.

Publish the `.vue` files together with the `.js` and `.d.ts` your Vue build produces from them
(for example `vite build` with `@vitejs/plugin-vue`, and `vue-tsc --declaration --emitDeclarationOnly`).

Invalid definitions retain HTML Next's source-located `HT` diagnostics. A valid construct that Vue
conversion cannot map produces source-located `HTC001` with the underlying code. Colliding generated
paths produce `HTC002` before any output is written, and an unsupported target version produces
`HTC003` before the graph is loaded.

React output is in development. It accepts the same quoted globs and mirrors the same source
directories under `generated/react/`, emitting `.tsx` and adjacent plain `.css` files. The CSS is
imported by each component; styled-components is not used. At present, React conversion covers
static markup, props and bindings, default and named/scoped slots, state/computed/handlers,
context, declared data, native form controls, safe HTML, and structural templates. Other valid
HTML Next constructs fail conversion explicitly rather than
producing output with silently changed behavior. Do not treat the React target as feature-complete
or parity-certified yet. Svelte is not supported.

React applications use their usual `hydrateRoot` call and error options. If the server root is
incompatible, React reports the recovery through `onRecoverableError` (or its default reporting);
the converter does not generate an `HR005` hydration entry or replace React's recovery flow.

For source-only distribution with automatic Vue or React conversion in the consuming app,
use the [Vite adapter](../html-next-unplugin/README.md#vue-and-react-source-imports). It also
generates consumer declarations, so publishers do not need separate framework copies.

To distribute preconverted copies of one authored library in all three forms, assemble the native HTML Next package from
the `.html` sources, then run the Vue and React library converters over the same quoted glob. Give
each conversion its own output directory so both `html-next.conversion.json` manifests survive:

```sh
html-next-convert vue 'components/**' --mode library --out-dir package/converted/vue-target
html-next-convert react 'components/**' --mode library --out-dir package/converted/react-target
```

The package can expose the native entry, the converted Vue entry, and the converted React entry as
separate subpaths. If publishing source output, point `./vue` and `./react` at the generated
`vue/index.ts` and `react/index.ts`, include their component files and CSS, merge both conversion
inventories' `package.dependencies` and `package.peerDependencies` into the package manifest,
and mark Vue and React as optional peers when each subpath is independently usable. Consumers
then compile `.vue` and `.tsx` with their normal bundler plugins. For precompiled distribution,
emit JavaScript and declarations from those entries and point exports at the built files. The
[installed-library test](./tests/library-distribution.test.ts) packs and installs the source-output
shape, then renders both framework entries from that independent consumer.
