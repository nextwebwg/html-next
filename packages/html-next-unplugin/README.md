# `@nextwebwg/html-next-unplugin`

Vite can convert imported Declarative Components sources into Vue, React, Preact, Svelte, or Angular components. Libraries
publish their HTML definitions; consumers use their normal component imports.

Named imports from component folders and pure re-export barrels resolve directly to the requested
framework components. Bundling an ordinary control therefore does not require an unused editor's
optional peers. Namespace imports, side-effect imports and barrels with authored runtime code keep
their ordinary module semantics. An imported optional component still requires its own peers.

## Check components in CI

Run `html-next-check` to check an authored component graph without writing generated components,
declarations, caches, or build output. Install `@nextwebwg/html-next-unplugin` as a development
dependency to use the command. Select the backend and graph mode used by your build:

```sh
html-next-check --target native --mode application src/components/app.html
html-next-check --target react --mode library 'components/**/*.html'
```

The default target is `native` and the default mode is `application`. All targets accept files,
directories, and quoted globs; directories scan recursively for HTML files. Linked components are
checked transitively. Avoid overlapping inputs: an entry listed twice is an error. Native checks
also discover installed HTML source packages, as the native Vite plugin does, and may omit local
entries when an installed source package supplies them. Framework checks require explicit HTML
entries and use the converter's graph planner.

The command checks the parser's declarations and constraints, graph resolution, and the selected
backend's lowering restrictions and output collisions. Controllers are never executed. It runs
compiler checks in memory; it does not run Vite, resolve application imports, or invoke the
framework's own typechecker. The existing `html-next check` remains a parser/graph inspection
check; use `html-next-check` for backend validation.

This command does not load `vite.config`. Pass the same entries, target, and mode as your build.
For framework checks with component-relative data URLs, supply `--public-root-url /app/` as you
would for conversion. Native checks accept repeated `--extension <name>` options for the plugin's
`extensions`, and repeated `--external-custom-element x-tag` options for its declared dynamic
boundaries.

### Combine with TypeScript

Use both checks: HTML Next checks authored HTML and compiler contracts; TypeScript checks authored
JS/TS controllers and application code. Include those files in your TypeScript project. To check
JavaScript too, enable [`allowJs`](https://www.typescriptlang.org/tsconfig/allowJs.html) and
[`checkJs`](https://www.typescriptlang.org/tsconfig/checkJs.html), with `noEmit: true`.

For a native project, a CI script can run:

```json
{
  "scripts": {
    "check:html": "html-next-check --target native src/components/app.html",
    "typecheck": "pnpm check:html && html-next-sync && tsc --noEmit",
    "ci": "pnpm typecheck && vite build"
  }
}
```

For a framework project using the Vite source adapter, prepare consumer declarations before
checking component imports:

```json
{
  "scripts": {
    "check:html": "html-next-check --target react --mode application 'src/components/**/*.html'",
    "typecheck": "pnpm check:html && html-next-sync && tsc --noEmit",
    "ci": "pnpm typecheck && vite build"
  }
}
```

Use `--target vue` with `vue-tsc --noEmit`, or `--target svelte` with `svelte-check`, for those
frameworks. Configure local HTML entries in the Vite adapter so `html-next-sync` prepares their
types. Include the generated declarations in the consumer project; local `.html` imports also
need [`allowArbitraryExtensions`](https://www.typescriptlang.org/tsconfig/allowArbitraryExtensions.html).
`html-next-sync` writes the files those typecheckers need; `html-next-check` itself writes none.
For each local component that declares a controller, the plugin and `html-next-sync` also write
`<tag>.host.d.ts` beside its definition, the typed host its controller imports as
`import type { Host } from "./<tag>.host.js"` ([Type a controller](https://nextwebwg.org/html-next/usage#typed-host)).
For preconverted output, run the converter before the framework typechecker instead of syncing.
Neither the check command nor declaration preparation provides general TypeScript-style inference
for every HTML binding expression. Runtime behavior and bundler failures still need tests/builds.

### Diagnostics for tooling

`html-next-check --json ...` writes `{ "diagnostics": [...] }` to stdout. Success has an empty
array. Each diagnostic has `code`, `message`, `severity` (`"error"` or `"warning"`), and an optional `source`
(a file URL or a converter-relative path). Source-located diagnostics also include one-based
`line` and `column` coordinates. Human-readable failures go to stderr as compact Jess-style rows,
without code excerpts:

```text
error HC013  Prop `age` has a min constraint that does not conform to its type; the constraint is ignored.  ·  components/child.html:3:5
```

The `file:line:column` label is an OSC 8 hyperlink to `vscode://file/…:line:column`, so terminals
that support these links can open the authored location in VS Code. Use `--no-color` or set
`NO_COLOR` to disable links for plain logs. JSON never includes terminal escape sequences.
Exit status is
`0` for success or warnings only, `1` for a compiler error, and `2` for invalid arguments or an
operational failure without a compiler diagnostic. Such operational failures go to stderr even with `--json`.

Checks collect independent failures across declarations, markup elements, component carriers,
and linked resources. Shared invalid resources are checked once, and diagnostics are deduplicated
and sorted by source location. Invalid declarations reserve their names during checking to avoid
secondary undeclared-name errors. An invalid element stops analysis of that element's dependent
contents; its siblings can still be checked. Parsing or graph-resolution failures stop backend
lowering for that graph, while a valid graph can report failures across several backend components.
Builds and conversions continue to stop at the first error and never emit output from recovered
check data. The checker can therefore report several errors in one run without promising every
possible error after a broken prerequisite.

Warnings never stop a check or a build. `HT022` warns when a bare word in an expression spells a
name in scope: `from:title="count"` is the keyword `count`, and `$count` reads the declaration.

Parser diagnostics point
to the relevant declaration or element; backend failures can point to the enclosing component.
Failures without an authored location show only the available file or message. Diagnostics do
not yet provide end ranges, unsaved-buffer analysis, or a language server. An editor or lint
adapter can call the same API:

```ts
import { checkHtmlNext } from "@nextwebwg/html-next-unplugin";

const diagnostics = await checkHtmlNext({
  target: "react",
  mode: "library",
  entries: ["components/"],
  root: process.cwd(),
});
```

The API returns a readonly diagnostic array and rejects on operational failures without a
compiler diagnostic. Native options accept the plugin's `dynamicBoundaries`; framework options
accept the converter's `publicRootURL` and `targetVersion`.
`formatCheckDiagnostic(diagnostic, { hyperlinks: false })` formats the same compact row for a
plain log; omit `hyperlinks: false` to embed the terminal file link.

## Framework source imports

```ts
// vite.config.ts — Vue
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ target: "vue" }), vue()],
});
```

For React, use `target: "react"` with `@vitejs/plugin-react` in place of the Vue plugin.
For Preact 11.1.0 or later, configure the Preact target with its standard preset:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ target: "preact" }), preact()],
});
```

Generated output imports `preact/compat` and uses Preact JSX. Consumers install `preact`;
SSR consumers also install `preact-render-to-string`. Prepare declarations with
`html-next-sync`, then run `tsc` with `jsx: "react-jsx"` and `jsxImportSource: "preact"`.

For server-rendered components with asynchronous binding modules, React and Preact applications import `renderPrepared` from their source component package and await `renderPrepared(<App />)`. Svelte applications use `await renderPrepared(App, { props })`. The returned HTML includes prepared data that generated components adopt during normal framework hydration. Vue and Angular use their ordinary server rendering lifecycle.

### Angular

Add the Angular target to your existing Angular AOT Vite pipeline:

```ts
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

// Include alongside the plugins that compile your application's Angular templates.
const components = htmlNext({ target: "angular", entries: ["src/components/**/*.html"] });
```

Install matching Angular packages, including `@angular/compiler-cli`, and its compatible TypeScript
version. The adapter invokes that compiler for generated components and links partial-Ivy
Angular dependencies. Your application's Angular compiler continues to compile its authored code.
The supported baseline is Angular 21.2.24.

Run `html-next-sync` before standalone Angular typechecking. Extend the generated
`src/html-next.angular.json` from your application tsconfig and include `src/html-next.d.ts`.
The generated config maps HTML and source-package imports to Angular class metadata, so
`strictTemplates` checks input bindings. `declarationsFile` relocates both generated files. If your application declares its own `paths`,
merge the generated path entries into that object; TypeScript replaces an inherited `paths` object.

```json
{
  "extends": "./src/html-next.angular.json",
  "compilerOptions": { "allowArbitraryExtensions": true },
  "angularCompilerOptions": { "strictTemplates": true },
  "include": ["src/**/*.ts"]
}
```

Import a generated class into your standalone component's `imports`, then use the native host:

```ts
import { UiButton } from "@example/controls";
// imports: [UiButton]
// template: '<button ui-button [label]="label">Send</button>'
```

A scoped `row` slot on `ui-table` exports `UiTableRowSlot`. Add it to `imports` with `UiTable`,
then provide `<ng-template ui-table-row let-item="item">...</ng-template>` inside
`<table ui-table>`. Template context types come from the declared slot props. Ordinary named
slots use `slot="name"`; default slots use ordinary children. Angular's standard
`provideClientHydration()` owns hydration. Native hosts, projected nodes, control defaults, and
sanitized markup retain their server identities. Data reads and module connections begin in the
browser. See the [converter limits](../html-next-converter/README.md) before converting a graph.

For Svelte 5, use its standard Vite compiler after the converter:

```ts
// vite.config.ts — Svelte
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ target: "svelte" }), svelte()],
});
```

The adapter discovers installed dependencies that declare the `html-next` export condition,
converts their source entry points, and generates framework declarations. No `entries` list
or component-name mapping is needed for those packages.

```ts
import { Button } from "@some/library";
```

## Publish an HTML source library

The recommended distribution is your HTML files and Vite-plugin instructions. No author build
script or generated index is required. Point the `html-next` export at your component folder:

```json
{
  "name": "your-library",
  "version": "1.0.0",
  "type": "module",
  "files": ["components"],
  "exports": { ".": { "html-next": "./components/" } }
}
```

The adapter includes `.html` resources in that folder and nested folders. Each definition gets a
named framework export: `<template component="ui-button">` becomes `UiButton`. Native consumers
import `createUiButton` with `htmlNext()`; Vite discovers installed source libraries automatically.
Use `npm pack` to test the published files, then publish with npm. Include linked definitions and
controllers in `files`, preserving relative paths; declare controllers' external dependencies in
the package manifest. The [publishing guide](https://nextwebwg.org/html-next/ship) covers the README
and consumption instructions.

Explicit subpaths can point to another component folder or directly to an HTML file. Only
concrete `html-next` export conditions opt into conversion; wildcard exports are not discovered.
The folder scan does not follow symlinks. For Vue, React, and Preact, an authored JS/TS barrel can supply
aliases instead of exposing every component in a folder:

```json
{ "exports": { ".": { "html-next": "./components/index.js" } } }
```

```js
// components/index.js
export { UiButton as Button, UiDialog as Dialog } from "./controls.html";
```

A multi-component HTML resource exposes a named export for each definition, with no default export.
The framework adapters preserve authored aliases. Existing `assembleComponentPackage` outputs keep
working; assembly is optional for source libraries.

### Generated types

The adapter uses `vue-tsc`, TypeScript, `svelte2tsx`, or Angular's `ngc` to emit declarations from the converted components.
These retain required props, allowed values, dependent prop types, and framework slot APIs.
Runtime source and declarations live under `node_modules/.html-next/<target>/`.
`src/html-next.d.ts` exposes the package's exports to the consumer's editor and typechecker.
Include that file in your TypeScript project; `declarationsFile` can change its location.
Generated files may be gitignored. Existing authored declaration files are never overwritten.

Vite prepares these files automatically at startup and during builds. Before standalone
`tsc` or `vue-tsc` runs, prepare them using the same Vite configuration:

```json
{
  "scripts": {
    "typecheck": "html-next-sync && vue-tsc --noEmit"
  }
}
```

For React and Preact, replace `vue-tsc` with `tsc`; for Svelte, use `svelte-check`. `html-next-sync` loads your Vite config; you do not
repeat the target or package list. An API is also available:

```ts
import { syncHtmlNext } from "@nextwebwg/html-next-unplugin";
await syncHtmlNext({ target: "vue", root: process.cwd() });
```

Unchanged generated sources reuse cached declarations. Edits to authored sources regenerate
components and types; the dev server reloads consumers. This first adapter supports Vite,
explicit package exports, and relative source-barrel imports. Non-Vite adapters retain their
native build mode. Framework conversion reports unsupported constructs as build errors.

### Local HTML resources

```ts
import { UiButton, UiDialog } from "./controls.html";
```

The adapter converts the app's component files as one graph when it starts: every `.html` file
under the Vite root that defines a component, outside `node_modules`, dot-directories and the build
output. An import of a file outside the root is converted on demand. Each local resource receives a
generated `controls.d.html.ts` beside the source. Enable TypeScript's `allowArbitraryExtensions` for these imports. To prepare local types
before any runtime import, configure `entries: ["src/controls.html"]` with the framework target.
`?raw` and `?url` imports keep Vite's normal behavior. Use `publicRootURL` when definitions contain
component-relative data URLs. The adapter supplies `parse5` for converted `$html` helpers.

## Native builds

Build integration for a closed Declarative Components application or library graph. The plugin
parses component sources during the build, emits native DOM factories, combines the graph's support
imports through the bundler, and writes `html-next.manifest.json` with the component and capability
inventory.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({
    entries: ["src/components/app.html"],
    mode: "application",
  })],
});
```

```ts
import { createApp } from "virtual:html-next/components";

document.body.append(createApp());
```

Each component compiles to direct DOM code: a cloned template plus the exact updates its state, conditions, lists, props, slots, and controller need. The bundle carries no template interpreter, and each component imports only the helpers its features use.

In application mode, the virtual module exports one `create<Name>` function for each component declared in the configured
application entries. A linked `<link rel="component">` dependency used as an empty custom-element
invocation is compiled to a call to that dependency's native factory rather than an inert unknown
element. Transitive factories remain internal to the application graph.

Library mode gives each configured public entry a stable, independently consumable virtual module:

```ts
// vite.config.ts
htmlNext({
  entries: ["src/components/card.html", "src/components/button.html"],
  mode: "library",
});
```

```js
export { createXCard } from "virtual:html-next/components/x-card";
```

Generated factories import runtime helpers through one `virtual:html-next/support` module. Its
graph-wide capability union and concrete package imports are recorded in
`html-next.manifest.json`, together with the public entries and direct component edges. Component
source parsing stays in the build process and is absent from browser output.

An unlinked custom-element invocation is rejected as an undeclared dynamic boundary. Applications
that intentionally delegate a tag to a separately delivered custom element must say so explicitly:

```ts
htmlNext({
  entries: ["src/components/app.html"],
  dynamicBoundaries: [
    { tag: "x-external-chart", strategy: "external-custom-element" },
  ],
});
```

Optional language extensions are off until the `extensions` option lists them. A component that
uses one that is off fails `HT024`, and an unknown name fails `HN013`:

```ts
htmlNext({
  entries: ["src/components/app.html"],
  extensions: ["transitions"],
});
```

A component publishes a state to `<context>` readers only when a component in the build reads it.
When components outside the build read a library's state through `<context>`, `publicState`
publishes every state. The framework adapter accepts it too:

```ts
htmlNext({
  entries: ["src/components/app.html"],
  publicState: true,
});
```

`transitions` animates what `$if`, `$each`, and `$match` add, remove, and move; see the
[Transitions guide](https://nextwebwg.org/html-next/transitions). `html-next-check` accepts the same
setting as repeated `--extension <name>` options.

The external element remains a native `document.createElement()` boundary and is listed with its
users in the manifest. Capability chunks and the universal HTML Next runtime are not yet dynamic
boundary strategies.

Linked invocations compile their props, projected content, events, refs, and structural flow into
native factories. Recursive components can render finite content; non-terminating invocation chains
fail with the runtime's nesting diagnostic.

Enable `hydrate: true` to generate factories that can adopt server-rendered roots. Pass the existing
root as the factory's third argument:

```ts
// vite.config.ts
htmlNext({ entries: ["src/components/counter.html"], hydrate: true });

// client.ts
import { createXCounter } from "virtual:html-next/components";

createXCounter({}, undefined, document.querySelector('[component~="x-counter"]')!);
```

For a server-rendered application, the shared compiler can select the factories its initial markup
needs. Import the hydration entry and call it after the markup exists:

```ts
import { hydrate } from "virtual:html-next/hydrate";

hydrate(); // document, or pass an Element or DocumentFragment
```

This entry also requires `hydrate: true`. Pure interpolation, static state seeds, conditions, and
loops do not by themselves require a browser factory. Events, two-way bindings, reads, lifecycle
work, context, scripts, and modules retain the relevant factories. Selection considers every
authored branch, including branches absent from the server output. The entry keeps the ownership
region around an interactive component so invocation, slot, and root-alias adoption continue through
the existing generated runtime. Every component's stylesheet remains available, including static
components whose factories are omitted. A fully static graph imports CSS and exports a no-op
`hydrate` function, with no component runtime.

Tell the compiler about browser access that template markup cannot express. For example:

```ts
htmlNext({
  entries: ["src/components/counter.html", "src/components/profile.html"],
  hydrate: true,
  client: {
    publicRoots: ["x-profile"], // application code updates or looks up an existing host
    creationRoots: ["x-profile"], // application code creates later instances
  },
});
```

Either list accepts `"all"` when the target is unknown. Library builds always preserve their public
entry hosts. Explicit `creationRoots` also export their factories from `virtual:html-next/hydrate`;
import those factory names when application code creates the instances. Opaque modules and
controllers conservatively retain the whole graph, since their
public API targets cannot be proven from template markup. This selection currently prunes complete
static ownership regions; it does not claim the smallest possible program for arbitrary JavaScript.
The bundler continues to select the runtime helpers used by retained factories. The ordinary
`virtual:html-next/components` exports keep their existing creation API.

`html-next.manifest.json` records the shared compiler's versioned `client` plan: `adoption` and
`creation` tag lists, per-component dependencies and retention reasons, and the hydration entry's
virtual module name. `supportImports` remains an inventory of the complete generated graph. The
virtual module name is a build input; resolve the emitted asset through the application's bundler
manifest before serving it. The native .NET renderer's consumption of this artifact remains under
development. Application hosts can use the same analysis to preserve the layer factories their client navigation
can create or update.

For components with producer modules exporting `prepare` and `adopt`, build a server entry with
the same native Vite configuration:

```ts
// prepare.ts, compiled as a server entry
export { prepare } from "virtual:html-next/prepare";
```

Pass that built entry's absolute module URL to `renderComponents` as `prepare.module`, alongside
the component definitions. The server prepares producer values and transfers their read identities;
factories adopt those records before connecting browser modules. Server preparation and client
factories use the same graph revisions. Current caller props take precedence over restored server
props, and controls retain edits made before hydration. Ordinary components import no binding
preparation helper.

### Server style assets

The native build manifest includes a `server` block for server renderers. Version 1 records component and stylesheet source SHA-256 fingerprints, the shared CSS compiler's root-value names, and emitted stylesheet filenames. `hasStyles` distinguishes a graph that requires compiled CSS. The final stylesheet filenames are collected after CSS emission, so they include the bundler's asset names and URL processing.

`server.preparedModules` lists the `tag` and compiler-owned `source` revision of each module with preparation and adoption exports. These are the same revisions used by the generated server preparation and browser adoption code. Server hosts can use them to match native preparation adapters to their deployed client modules.

A server loads the manifest during startup, verifies matching component sources, and includes the listed stylesheets relative to its deployment's asset base. The .NET consumer is documented in [HTML Next for .NET](../html-next-dotnet/README.md#use-built-style-assets). These are build artifacts; language behavior remains defined by the [public proposal](https://nextwebwg.org/declarative-components/).
