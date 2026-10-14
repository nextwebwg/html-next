# `@nextwebwg/html-next-converter`

Converts a Declarative Components application or library graph into Vue 3.5 or Svelte 5 single-file
components, or React 19.3 TSX components. Once converted, HTML Next is gone. Each `.vue` file imports Vue,
its nested components, its controller (copied beside it), and only the generated helpers its
features need. A Vue component using
`$html` imports `vue/html.ts`; that helper requires `parse5` as an application dependency for
deterministic SSR. It parses inert fragments and applies one pinned safe-default allowlist in every
browser and on the server. It deliberately does not call native `setHTML()`, even where available:
Firefox currently parses malformed table content differently from Chromium, WebKit, and `parse5`,
which would make hydration browser-dependent. Props, state, computed values, bindings, structural
directives and slots map to Vue's own facilities; declared events remain native
`CustomEvent`s on the lowered root (Vue emits are reserved for `v-model` updates), and styles become
`<style scoped>`. `:host` selects the root by its tag as a class, and a component the styles select
by tag carries that class where it is used, so Vue passes it to the child's root.

Every component imports the shared `vue/host.ts` for what each one does the same way: consumer
attributes on the root, the hydration root check, checked handler writes, and the expression and
rendering helpers its template calls. A bundler keeps only the helpers a component imports, and an
application ships each one once.

Components declaring props import `vue/props.ts`. Invalid incoming values remain available at
their source while the root reports validity; a later typed binding is checked separately. A
Vue property binding should supply a number or boolean as that type, not as a string. Prop-free
components do not include this helper.

```sh
html-next-convert vue 'components/**' --mode library --out-dir generated
```

For a check without output, use `html-next-check --target vue --mode library 'components/**'`
from `@nextwebwg/html-next-unplugin`. See the [CI and diagnostic API guide](../html-next-unplugin/README.md#check-components-in-ci)
for combining compiler checks with TypeScript and framework typecheckers. Programmatic converter
users can call `checkConversion` with the same options as `convertComponents`, omitting
`outDirectory`; it returns the planned conversion manifest, writes no files, and throws the same
compiler diagnostics as conversion. Independent check failures are collected in
`HtmlDiagnosticAggregateError.diagnostics`; conversion itself continues to stop at the first error.
Pass `onWarning` to receive warnings, such as `HT022`, that do not fail the check.

Quote the glob so the converter, not your shell, expands it. It discovers every `.html`
component below `components/`, including definitions with no incoming component link, and
preserves the source directory layout beneath `generated/vue/`. One HTML resource may define
several `<template component>` carriers; each gets its own named export. Names retain their
prefix: `ui-button` becomes `UiButton`. A directory path such as
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
`dependencies` only when an emitted `$html` helper needs it; Vue, React, or Svelte appears in
`peerDependencies` for its respective output. Dependencies imported by authored controller
modules remain the publisher's responsibility.

Publish the `.vue` files together with the `.js` and `.d.ts` your Vue build produces from them
(for example `vite build` with `@vitejs/plugin-vue`, and `vue-tsc --declaration --emitDeclarationOnly`).

Invalid definitions retain HTML Next's source-located `HT` diagnostics. A valid construct that Vue
conversion cannot map produces source-located `HTC001` with the underlying code. Colliding generated
paths produce `HTC002` before any output is written, and an unsupported target version produces
`HTC003` before the graph is loaded.

React output accepts the same quoted globs and mirrors the same source
directories under `generated/react/`, emitting `.tsx` and adjacent plain `.css` files. The CSS is
imported by each component; styled-components is not used. Components import the rendering and
binding helpers their markup and handlers call from the shared `react/render.tsx`, which an
application ships once; the output is formatted. React conversion covers
static markup, props and bindings, default and named/scoped slots, state/computed/handlers,
context, declared data, native form controls, safe HTML, and structural templates. The shared
conformance corpus and feature-specific React fixtures compare browser behavior, server output,
hydration, and exact pixels with the live runtime in Chromium, Firefox, and WebKit. Constructs
that cannot be represented fail conversion explicitly rather than silently changing behavior.
Svelte output uses Svelte 5 runes, snippets, attachments, and public lifecycle APIs, with `.svelte`
components under `generated/svelte/`, each with its styles in its `<style>`. It supports props (including generic
and state-selected types), state/computed/handlers, named and scoped slots, native events, context, data reads, controllers and refs, native form controls, safe HTML, structural
flow, and keyed lists. Native-control helpers preserve authored reset defaults and dirty edits;
Svelte's normal compiler owns rendering, SSR, and hydration. Components import the rendering and
binding helpers their markup and handlers call from the shared `svelte/render.svelte.ts`, which an
application ships once. Scripts are formatted in `sv create`'s style. Markup breaks lines inside tags,
because Svelte renders whitespace between elements as a space.

```sh
html-next-convert svelte 'components/**' --mode library --out-dir generated
```

The current supported Svelte baseline is 5.57.1. Compile generated files with the standard Svelte
compiler or `@sveltejs/vite-plugin-svelte`. Source consumers can use `svelte-check`; publishers
emitting declaration files can use `svelte2tsx`. The generated public types cover props, native and
declared event callbacks and scoped slot fields. Both graph modes export components; application and library consumers use public `mount`/`hydrate`
or their framework's usual mounting and hydration flow.
Svelte support uses the unmodified framework; consumers do not install a runtime patch.
One known upstream gap remains: reordering a keyed row can blur its focused input. Svelte uses
ordinary DOM insertion to move the row, which can clear browser focus. In Svelte 5.57.1, our
Chromium, Firefox, and WebKit checks retain edited values and selection but lose focus;
Chromium also fires `blur` and `focusout`. The native HTML Next runtime retains focus in engines
with state-preserving `moveBefore`; its WebKit insertion fallback has the same focus loss.
This affects both mounting and hydration. See [Svelte issue #3973 and the editable Playground
reproduction](https://github.com/sveltejs/svelte/issues/3973#issuecomment-6003429271). Converter tests keep
this difference explicit while continuing to check rendering, edits, events, lifecycle and hydration.

Feature helpers are emitted once per converted graph and imported only by components that need
them. Style bindings record `cssstyle` and `css-tree` in server dependencies; the generated helper's
standard `browser` mapping uses the live element's CSSOM in browser builds.

React applications use their usual `hydrateRoot` call and error options. If the server root is
incompatible, React reports the recovery through `onRecoverableError` (or its default reporting);
the converter does not generate an `HR005` hydration entry or replace React's recovery flow.

For source-only distribution with automatic Vue, React, or Svelte conversion in the consuming app,
use the [Vite adapter](../html-next-unplugin/README.md#framework-source-imports). It also
generates consumer declarations, so publishers do not need separate framework copies.

To distribute preconverted copies of one authored library in all four forms, assemble the native HTML Next package from
the `.html` sources, then run the Vue, React, and Svelte library converters over the same quoted glob. Give
each conversion its own output directory so each `html-next.conversion.json` manifest survives:

```sh
html-next-convert vue 'components/**' --mode library --out-dir package/converted/vue-target
html-next-convert react 'components/**' --mode library --out-dir package/converted/react-target
html-next-convert svelte 'components/**' --mode library --out-dir package/converted/svelte-target
```

The package can expose the native entry and the converted Vue, React, and Svelte entries as
separate subpaths. If publishing source output, point `./vue`, `./react`, and `./svelte` at the generated
`vue/index.ts`, `react/index.ts`, and `svelte/index.ts`, include their component files and CSS, merge the conversion
inventories' `package.dependencies` and `package.peerDependencies` into the package manifest,
and mark Vue, React, and Svelte as optional peers when each subpath is independently usable. Consumers
then compile `.vue`, `.tsx`, and `.svelte` with their normal bundler plugins. For precompiled distribution,
emit JavaScript and declarations from those entries and point exports at the built files. The
[installed-library test](./tests/library-distribution.test.ts) packs and installs the source-output
shape, then renders the framework entries from that independent consumer.

For guaranteed unused-component **and CSS** pruning in a preconverted package, expose individual
component subpaths from the conversion inventory, such as `./react/XCard` pointing to
`react/components/XCard.tsx`. Consumers can then import only the components they use. Some
bundlers retain CSS side-effect imports from unused named re-exports in a shared `./react` barrel,
even when they remove the unused JavaScript. The on-demand Vite adapter handles pruning for its
generated named exports.

Controllers initialize once per component instance. Use `host.on("connect", setup)` for setup
that must run on every connection; return its disconnect cleanup from `setup`. Register other
native events with `host.on(type, listener)`, which detaches listeners while disconnected and
reattaches them on reconnect. A handler can dispatch its native `$$event` or selected event fields
to that listener. `<method>` and automatic named-export element methods are unsupported.

`host.state` contains mutable state, readonly computed state, and inherited context. Resources
are read through `host.data.name`, including their readonly response and status fields. Invalid
authored state assignments retain the prior value and warn; native control edits retain their
ordinary validity behavior. Props use `:host([prop])` styling, and state uses `:host-state([state])`.
The [public proposal](https://nextwebwg.org/declarative-components/javascript/) defines these contracts.

Handler `<dispatch target="name">` resolves the current component instance's `$ref="name"`, never a DOM ID. Collection refs receive separate native events in rendered order; payload expressions are sampled once. React, Vue, and Svelte outputs preserve the authored event type and flags, and a targeted request does not become a framework emit from its sender. See [dispatch targets](https://nextwebwg.org/declarative-components/bindings/#dispatch-target).
