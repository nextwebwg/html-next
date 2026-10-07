# Changelog

## 1.0.0-alpha.34

### Changed

- Builds compile every component to direct DOM code with the live runtime's semantics: controllers, state, computeds, `$if`, `$match`, keyed and unkeyed `$each`, `$html`, props, slots, component invocations, declared data and contexts. The `experimentalDirectExtend` option and the general-runtime fallback are removed, and the build manifest no longer has a `directExtend` field. Compiled roots are visible to `getComponentHost`, `inspectInstance` and `serializeRenderedForm`, and hydrate live.
- Components that the smaller static, primitive-state and scalar-prop emitters compiled now render exactly as live does. Slot ranges are marked, prop validity uses live's messages and validity API, and inspection and hydration see them. Such a component alone bundles about 6.6 KB gzip of shared support, or 11 KB with props, paid once per application.
- A controller's write through `host.state` into a computed or context value, nested writes included, is refused with a read-only warning, as in the live runtime.

### Improved

- A compiled component bundles only the type checks its declared props and events use, not the type-expression parser, literal parser, unused formats or color keywords. Live type checks are built from the same combinators and are about 10% faster.
- A document has one MutationObserver for connection tracking, shared by the live runtime, compiled components and the React, Svelte and Vue targets. Bound `<select>` elements in the Svelte and Vue targets share one observer per document for their option lists.

## 1.0.0-alpha.33

- Simplify the public performance documentation and package READMEs.
- Server rendering uses jsdom 30.0.1 (previously 27.4.0). jsdom 30 declares Node `^22.22.2 || ^24.15.0`, narrower than HTML Next's `>=22.13 <23 || >=24 <25`.
- `html-next-check`, installed with `@nextwebwg/html-next-unplugin`, checks native, Vue, React, and Svelte component graphs without writing build output. One run reports independent declaration, binding, resource, and backend errors as source links or JSON, for CI and editor adapters to run beside TypeScript.

## 1.0.0-alpha.32

### Changed

- Validation leaves application stylesheets untouched: it no longer reads connected or adopted stylesheets, observes stylesheet changes, copies rules, or patches CSSOM methods. `installValidityStyles` is removed. Component styles still transform validity selectors when compiled; call `rewriteValiditySelectors` on any shared application CSS that uses them.
- Templates and keyed lists read reactive state as plain objects, and a row gets a proxy only when controller JavaScript touches it. Controllers still receive one canonical proxy per object. Writing an object's proxy over the object itself (`rows[0] = rows[0]`) is now no change. A getter defined directly on a plain object runs with the plain object as `this` when a template reads it, and its reads are not tracked; class instances still read through their proxy.

### Added

- `renderComponents()` returns `styleOwnership`, the component tags and tested state names for its CSS. Hydration reuses explicitly owned server-delivered component CSS, including one bundle shared by several components, instead of compiling and injecting it again.
- Experimental `experimentalDirectExtend` build option compiles components with controllers, state, `$if`, and keyed `$each` lists to direct DOM code. It is off by default. If any component in a graph is not yet supported, the whole graph builds exactly as it does without the option.

### Improved

- Selecting a keyed row updates only the previously and newly selected rows when a class binding compares the loop key for equality, in the live runtime and compiled output.
- Live list rendering keeps less bookkeeping per row and per list: proxies share one trap handler, keyed blocks keep their own positions, and removed nodes are checked against connected component roots without walking each removed subtree.

### Documentation

- The package READMEs introduce HTML Next more directly and summarize its js-framework-benchmark results, with the full receipts in the guide.

## 1.0.0-alpha.31

- Browser adoption retains parent refs, reactive bindings, declared child props, and events on nested components rendered as native roots, whether the nested component is adopted before or after its parent. Bindings and refs follow child root replacement without replacing projected content.
- Reactive list rendering does less work per row: ordinary native rows clone a cached structure, adjacent removed rows are removed together, and stopped render effects release their ownership, so repeated create and clear cycles no longer retain DOM nodes.

## 1.0.0-alpha.30

- Build styles preserve `@import` and other statement at-rule semicolons when hoisted.

- HTMLKit can strip numeric file-route ordering prefixes without changing physical loader and import paths.
- HTMLKit exposes ordered concrete route navigation to applications and loaders, with an exported native navigation component.
- Installed and browser consumers exercise TypeScript controllers referenced with emitted `.js` module names.

## 1.0.0-alpha.29

### Added

- Svelte conversion for application and library output, including source-folder Vite imports, hydration, slots, and controller lifecycle behavior.
- Handler `$$event` references and the `event` payload type preserve native events, including when passed through another event's detail.
- `<dispatch target="ref">` sends native events to component-local refs. Collection refs receive one event per rendered element, with a shared payload evaluated once.

### Changed

- Controllers initialize once per component instance and use `host.on("connect", ...)` for setup and cleanup on each connection.
- Resource data lives under `host.data`; mutable and computed state live under `host.state`. Invalid and readonly writes warn and retain the accepted value.
- Prop styling uses `:host([prop])`; `:host-state()` selects mutable or computed state.
- Removed the unsupported `<method>` API and its generated element-method and checker bridges. Use reactive props and native events with controller listeners.

## 1.0.0-alpha.28

### Changed

- HTMLKit page and layout metadata now belongs inside its owning component carrier. File-level `htmlkit:page` selects the entry when a file declares multiple components. Helper metadata never contributes to a selected page or layout.
- HTML Next accepts and ignores safe direct carrier metadata, preserving one rendered root and excluding metadata from bindings, output, and component dependencies.

## 1.0.0-alpha.27

### Added

- Public `@nextwebwg/htmlkit` application platform with file and registered routes, static generation, Node loaders, development and preview commands, and HTML Next browser adoption.
- Default and named layouts in `app/layouts`, page layout overrides, and directory layout defaults using ordinary named slots.
- Page entry selection with `htmlkit:page` metadata and application-wide unique page names, independent of route URLs and browser bundle locations.
- Declarative title, meta, and link metadata with loader-prop bindings and page overrides. Regular HTML Next resource loaders accept and ignore inert metadata without changing the host document.
- A documentation consumer that exercises routing, Markdown content, generated component reference data, search, themes, and interactive examples; a concrete design for future request-time rendering.

### Fixed

- Components sharing a source file retain each component's stylesheet in HTMLKit browser builds.

## 1.0.0-alpha.26

### Fixed

- Inline row paths and `$value` now generate identical direct Vue text bindings, without an extra component per row. Loop aliases use inferred types for lowering rather than adding declared-reference guards.
- Mixed inline Vue text uses direct string concatenation instead of allocating a temporary array, preserving authored whitespace and empty values.
- Row `$value` expressions that return an invalid result retain the last valid text across keyed moves, matching inline expressions and the live runtime.

## 1.0.0-alpha.25

### Fixed

- Generated Vue components type nonempty scalar `concat()` calls as text, allowing strict consumer checks for ARIA attributes, IDs, slots, and child-component props. Invalid calls retain their sentinel type and runtime behavior.

## 1.0.0-alpha.24

### Added

- Reactive inline text expressions with single braces, including `{$user.name}`, across native, Vue, React, and server rendering.
- Intl formatting expressions with explicit formatters or declared-type inference, native options, and an optional locale; Node 22 server rendering includes duration formatting.
- Reproducible reactive benchmarks, pinned development-only comparison libraries, and a required performance regression check against main.

### Improved

- Repeated Intl formatting reuses bounded native formatter instances across updates and generated component instances.
- Identifier names exclude dollars, dashes, and escapes; references stay case-sensitive, and public prop names cannot differ only by ASCII casing.

## 1.0.0-alpha.23

### Added

- Publish HTML source folders directly, including nested components, and consume the same package with native, Vue, or React Vite plugins without a library build script.

- Source-only Vue and React library imports through the Vite adapter, with on-demand conversion, generated consumer declarations, and standalone type-sync support.
- Multiple component definitions in one HTML resource, each exposed as a distinct named export while unused components remain tree-shakeable.
- React 19.3 conversion for application and recursively discovered library component graphs. Generated TSX, plain CSS, controllers, and feature-specific helpers run without the HTML Next runtime.
- Distributable library output with typed React exports and dependency metadata, alongside native HTML Next and Vue entries.

### Improved

- Native Vite builds emit the generator’s scoped CSS, and Vue/React adapters leave Vite’s application HTML entry intact.

- React parity for props, state, computed values, events, context, slots, declared data, native form controls, safe HTML, structural templates, controllers, SSR, and hydration.
- Shared Vue and React generated sanitizer and data-URL logic, while keeping framework-specific rendering and control behavior separate.
- Three-browser behavior and pixel checks for the shared conformance corpus and feature-specific converter fixtures, including an installed nested-library consumer.

React applications continue to use React's native `onRecoverableError` handling for incompatible hydration roots; the converter does not replace that flow with an `HR005` wrapper.
