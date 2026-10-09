# Changelog

## 1.0.0-alpha.41

### Breaking

- HTMLKit metadata uses the `hk:` prefix: `hk:page`, `hk:layout`, `hk:label`, `hk:navigation`, and `hk:alias`. The old `htmlkit:` spelling is an error that names its replacement. Rendered layers have `hk-layer-N` ids, and the browser event is `hk:ready`.
- The navigation component is `<hk-nav>`, after the `<nav>` it renders, in `components/nav.html`. It and HTMLKit's other built-in components need no component link, and the `hk-` prefix is reserved for them.
- `@/` is the project root in component links, controllers, stylesheet imports, and loader imports. HTML Next's Node loader accepts an application `importMap`, as its browser loader does, and HTMLKit passes `@/` through it and to Vite.
- Ordering prefixes are a number and a dot, and always apply: `01.guide/02.install.html` routes to `/guide/install/` and orders navigation. The `routeOrdering` option is removed. A dash no longer marks an ordering prefix, so rename `01-guide` to `01.guide`; a name such as `2024-recap` keeps its URL.
- `$if`, `$with` and `$match` rebuild their content only when the decision changes, in the live runtime and compiled output alike. The decision is the `$if` result, the chosen `$match` arm, or the text of a dynamic slot name in the content. Any other change updates the content in place. Previously, any change to what the decision read rebuilt it. Under `<div $if="$count > 0"><input></div>`, changing `count` from 1 to 2 no longer replaces the `<input>`, so typed text, focus and selection survive. Nested components are no longer re-created. `$with` and `$match` aliases update in place. Compiled output also rebuilds a `$match` arm when a slot name inside it changes, as live does. React conversion keys nested `$match` arms, so switching between arms of the same shape renders the new arm afresh rather than reusing the old arm's elements.
- Attribute, class, style and text bindings, `$value` and `$html` write only a result that differs from what they last wrote, in the live runtime and compiled output alike. Previously the live runtime rewrote the same value whenever something the binding read changed, and compiled output did so for `$html` and for class toggles on an element that also binds `class`. An unchanged `$html` no longer replaces its content, so focus and selection inside it survive. Property bindings and bound control values still write each new result.
- A `<data>` read requests again only when one of its `from` parameters resolves to a different value. Previously any change to what a `from` parameter read restarted the request, even when the URL stayed the same. Reconnecting still requests.

### Added

- The optional `transitions` extension animates what `$if`, `$each`, and `$match` add, remove, and move. `$transition` takes a keyframes name (a built-in `fade`, `fly`, `scale`, or `blur`, or any `@keyframes`) with an optional duration, easing, and delay; leaving plays it in reverse. `$transition-name` gives an element an identity, so one element can morph into another. The Vite plugin builds it with `extensions: ["transitions"]`, and `html-next-check` with `--extension transitions`. Without the option the directives fail `HT024`; an unknown extension name fails `HN013`, and a malformed value `HT025`. The live runtime and Vue, React, and Svelte conversion warn and build without animation. Components that do not use the directives compile exactly as before; the shared support every compiled component bundles grows by 4 B gzip. See the new Transitions guide.
- Compiled components can hydrate server output. With `generateComponent(definition, { hydrate: true })`, a component's factory takes a server-rendered root as its third argument, `create<Name>(options, html, root)`, and binds that DOM in place instead of creating its own. Hydration restores the instance's props and state from `data-html-next-instance`, adopts conditions, list rows, slot ranges, fallbacks, scoped renderings and nested components where the server rendered them, and keeps control values, focus and selection edited before startup. Each root connects, and its controller runs, once the outermost hydration has finished, in document order. A block whose server markup does not match its template is created afresh in its place. Modules generated without the option are unchanged.

### Changed

- HTMLKit inlines an optional `app/head.js` as a classic script after each page's charset declaration and before its stylesheets, so it runs before first paint, for example to apply a saved color theme without a flash of the default one. Text that would end or nest the script (`<!--`, `<script`, `</script`) is rejected.
- HTMLKit applications serve pages through `application.fetch(request)`, which takes a native `Request` and returns a `Response` on Node, Deno 2.8+, and Bun. The development server uses it for every page, and CI runs it on Deno and Bun.
- The HTMLKit development server's component stylesheet links load again. Vite requests them with a `?direct` query that HTMLKit's virtual sources did not recognize, so they returned 404 and each dev page first painted without component CSS until its module injected the styles, fading any transitioned colors in.
- HTMLKit plugins add page formats. A plugin's `pages` compiler claims file extensions such as `.md` and turns each file into an HTML Next page resource; HTMLKit then routes, orders, watches, renders, and builds those pages like `.html` pages. While compiling, a page can resolve another page's URL with `page.href` and serve a referenced file with `page.asset`. A plugin's `config()` contributes options, including a layout whose loader is a module object and a `headScript` inlined before `app/head.js`.
- `pages` lists the page directories and the URL prefix each serves, defaulting to `app/pages` at `/`. One directory may serve several prefixes.
- Pages can set their navigation label (`hk:label`), stay out of navigation (`hk:navigation` with `content="hidden"`), and add alias routes (`hk:alias`). An alias never appears in navigation and marks its page's own entry current.
- HTMLKit's `css` option adds page-wide stylesheets to every page, such as `['@/styles/page.css']`, for rules like `html` and `body`. They load before the page is shown, in builds and in development.
- HTMLKit plugins compose with the site: page folders, stylesheets, and routes a plugin adds join the site's own instead of replacing them, and `app/pages` stays. A page folder can name its own `layout`, which its pages use unless they name one, so a plugin's layout no longer wraps the whole site. `optional: true` skips a folder that doesn't exist.
- HTMLKit has built-in `<hk-breadcrumbs>` and `<hk-pager>`, unstyled and accessible like `<hk-nav>` and needing no component link. Loaders get `breadcrumbs()`, the existing pages from the home page (or `from`) down to the current one, and `pager()`, the pages before and after it in navigation order.
- HTMLKit navigates between pages in place, as Nuxt does. After the first page hydrates, a link to another page under the base loads that page's browser module and its data payload, renders the page in the browser with the server's own steps, keeps every layout the two pages share with its DOM, state, and controller, and swaps the rest. A kept layout takes its loader's new props, so `<hk-nav>` marks the new page current. The title and head metadata follow the new page, and screen readers hear its title. It uses the Navigation API (Chrome 135, Firefox 147, Safari 26.2), so back and forward, scrolling, and focus behave as for document loads; older browsers and readers without JavaScript keep loading whole pages.
- Builds write each page's payload to `_htmlkit/pages/<route>/payload.json`, and `application.fetch` (so `htmlkit dev`) serves it from the same render: the head, and each layer's component, prop attributes, and loader state. Loader `data` stays private. A payload is about 0.5 KB gzip where the docs proof's HTML is 1.4 to 4.6 KB. A page whose payload is missing or fails, or that cannot render from it, loads from its static HTML, and one that cannot render in place at all (missing, failed, or redefining a component already on the page) loads as a document. `RenderedPage` gains `layers`, and the build manifest lists each page's shared `chunks`.
- The `prefetch` option chooses what links load before a click: `interaction` (the default) loads a page's payload and module when its link is hovered or focused for 80 ms or touched, and only shared chunks for links on screen; `visible` also loads payloads and modules for links on screen; `none` loads nothing. `data-hk-prefetch` on a link or an ancestor overrides it. Prefetching never runs a page's code. Other sites, other base paths, files, downloads, new tabs, modified clicks, same-page fragments, posted forms, and links inside `data-hk-reload` load normally. An author's `@view-transition { navigation: auto; }` animates client navigation too. The client and the runtime functions it uses add 4.4 KB gzip (10%) to the first page; `docs/client-navigation.md` records the design and measurements.
- HTML Next's `adoptRenderedProps(element, rendered)` applies the props a fresh server rendering recorded on a component root to a live instance a framework keeps, through the `updateComponentProps` channel, without resetting its state or DOM.
- HTML Next's `replaceProjectedNode(current, next)` replaces a node a live component projects into a slot, in the document and in the component's projection: the new node is marked for slotted styles, appears in `host.slots` and the rendered form, and is what the slot renders if it renders again. Replacing projected content with `replaceWith` left the component projecting the old node.
- HTMLKit names a page's shared-import stylesheet for its whole component graph. Pages under one layout shared a name, so a build linked every such page to the last page's styles, and development served whichever page rendered last.
- `buildApplication()`'s `browserInputs` lists only source files. It also listed HTMLKit's virtual component stylesheets, which a tool reading each input could not open.
- A parent that passes a child component the value it already has no longer re-runs the child's prop validity, or rewrites its `data-*` reflection, in the live runtime and compiled output alike. The `data-valid`, `data-invalid`, `data-user-invalid` and `aria-invalid` markers, and `data-*` prop reflections, are written only when they change. In the live runtime, a `$each` row keeps its `loop` record through list updates, and only the fields that change are written, so `$loop.index` readers no longer re-run when only the count changes.
- Vue, React and Svelte conversion follow the same rules for unchanged values. A `<data>` read requests again only when a `from` parameter changes; React previously also requested when only an `expr` parameter changed, and Vue and Svelte whenever a `from` parameter's inputs changed. In React, a computed value that recomputes to the same result no longer reruns the effects that read it. In Vue and Svelte, an effect that reads one prop no longer reruns when another prop changes. Writing a value read from `host.state` back to it is no change. Svelte attribute and style bindings write only a changed result.
- React conversion tracks what a controller reads from `host.state` path by path: `items.push(…)` or `items[1].name = …` no longer reruns an effect that read only `items[0].name`, while assigning a new list still does. A controller's `host.computed` notifies only when its value changes. Converted React inputs and textareas skip renders that change none of their props, so React no longer rewrites their `name`, `type` or default on every update, and bound controls take their authored defaults while mounting. In every converter, bound controls, select options and the `aria-invalid` mirror write their defaults only when they differ, and in Svelte a `NaN` that stays `NaN` counts as unchanged.
- A `<data>` read requests again when a whole list sent as a `from` parameter changes in place: after `tags.push("b")` or `tags[0] = "z"` under `<param name="tags" from:value="$filter.tags">`, in the live runtime and compiled output alike. Compiled output previously requested again only when a new list was assigned, and the live runtime tracked the list's items only as a side effect of building the request. A list passed whole to a child prop already followed its items in both.
- Compiled output no longer throws `TypeError` when a `$match` of two or more arms with no `$else` has chosen no arm and another value it does not read changes.
- A new guide page, Versions and stability, says that alpha releases follow the proposal's live draft and may break components, sets out what 1.0 will promise within a major version, and shows how a library declares the tools versions it supports (`peerDependencies` today; the planned `htmlNext.snapshot` and `htmlNext.extensions` fields) and how extensions will be enabled. The READMEs, the library publishing guide, and the release mechanics link to it.

### Fixed

- Hydration by the live runtime adopts a `<template $each>` row's server nodes instead of rendering the row again beside them, which showed each row twice.
- A compiled component evaluates an empty object or list literal (`format($names, 'list', {}, $locale)`, `format([], 'list')`) and a call with no arguments as the live runtime does. They compiled to a missing argument, so the call rendered nothing.
- The `html-next` and `html-next-convert` commands run when started through their installed `node_modules/.bin` link, as `npx`, package scripts and direct calls do on macOS and Linux. Earlier releases exited there without output or files.

## 1.0.0-alpha.40

- Component CSS prevents Firefox 155's scoped SVG class rules from leaking across scope limits. Live loading, graph CSS, Vite, SSR, React and Svelte keep owned, projected and nested component styling distinct through DOM moves. The compiler uses a Firefox-specific private CSS marker; shared boundary rules are delivered once per graph or live document. Author inheritance remains intact; no DOM observers or ownership attributes are added. Mozilla bug 2080046 tracks the underlying browser defect.

## 1.0.0-alpha.39

- Shared and inline component styles preserve stylesheet-local `@namespace` declarations in live loading, Vite builds, SSR, and framework conversion. Imported default namespaces become explicit selector constraints; conflicting named prefixes remain isolated. Firefox 155's native SVG scope-limit defect is documented with a standalone reproduction and Mozilla bug 2080046.

## 1.0.0-alpha.38

- Component styles support shared CSS with ordinary `@import`. Live loading, Node graphs, SSR, HTMLKit, native Vite builds, and framework conversion resolve nested imports before scoping, retain source-relative assets and import conditions, and reuse source fetches. Compatible uses share one delivered body; distinct layers, conditions, cascade positions, global overrides, and target scope boundaries retain separate occurrences when needed. Styles follow graph order and stay in place when instances move or remount. Synchronous compilation diagnoses unresolved imports instead of emitting global imports. Imported `@namespace` is currently HY004 because flattening it would change selector matching.
- Component style compilation preserves conditional and layered name-defining rules, including keyframes, in source order. Zero-specificity owner and pseudo-element guards prevent Firefox scope-boundary leaks and stale root styles. Defaults remain explicit CSS; no automatic box-model reset is installed.

## 1.0.0-alpha.37

- Vue component styles preserve native selector boundaries: ordinary selectors match owned descendants, while root elements and their pseudo-elements require explicit `:host` selectors. Nested component roots remain outside the parent’s style scope, and Vue slot scoping is preserved.
- Compiled components update rows inside a nested `$each` when an outer row moves, or when its item or an outer state value changes, as the live runtime does. Before, `<li $each="row, i of $rows"><b $each="n of $row.tags">{$i}</b></li>` kept each row's old `$i` after a reorder (and showed `undefined` at first), an inner row's `{$row.label}` missed writes to that row's `label`, and rows two loops deep missed state changes. Rows keep their position only when something in or below them reads it. A reorder re-runs only the moved rows' position bindings, and a count change only rows that read `loop.count` or `loop.last`.
- Compiled lists whose rows read their position visit only the rows a reconcile moved: an append or a pop leaves every existing row alone. This adds 15 B gzip to keyed list output.

## 1.0.0-alpha.36

- `bind:` writes through a `$each`, `$with`, or `$match` alias of a state path, as the proposal specifies. `<div $with="$draft.owner as owner"><input bind:value="owner.name">` writes `draft.owner.name`, and `<li $each="row of $rows"><input bind:value="row.label">` writes that row's `label`, in the live runtime, compiled output, and Vue, React and Svelte. An item of a `$where`, `$sort`, or `$limit` list, and an outer loop's item written from an inner loop when the outer loop names no index, are `HT005` with the reason; name the outer loop's index (`row, i of $rows`) to write through it. Replacing a whole loop item (`bind:value="tag"` over a list of strings) is also `HT005` for now; bind one of its fields. Compiled output writes a row's field through the row's item, so no row has to keep its position for it. A `$with` alias that shares a state's name no longer writes that state.
- Components parsed in the browser log `HT022` to the console when a bare keyword spells a name in scope, so a missing `$` shows up without running `html-next-check`. The message quotes the expression.
- Rebuild brand symbols and lettering with clean vector geometry, removing jagged raster-trace edges while preserving the approved N spacing.

- HTML Next has approved vector and PNG brand assets, separate symbol-only avatars and full name lockups, and a branded repository introduction.

- HTMLKit has a guide at [nextwebwg.org/htmlkit](https://nextwebwg.org/htmlkit/), authored in `packages/htmlkit/docs/guide`: routes and layouts, loaders and browser delivery, ordered routes and navigation, and configuration. The package README now links to it and states the supported Node range, `>=22.22.2 <23 || >=24.15 <25`.

## 1.0.0-alpha.35

### Breaking

- A `$sort` key is a path from the loop item, so a field can no longer be confused with the item: under `$each="p of $products"`, write `$sort="p.price,-p.name"`, and `$sort="p"` to sort by the item itself. A bare field such as `$sort="price"` is a parse error (`HT023`) that suggests `p.price`. Like `bind:` and `<set name>`, a key accepts a leading `$` even though it is not required (`$sort="$p.price"`).

### Changed

- The performance guide publishes js-framework-benchmark results again, measured on 1.0.0-alpha.34's default Vite build: 0.936× Solid, 0.920× Svelte, 0.861× Vue and 0.711× React Hooks, from 8,862 gzip bytes, with the raw results in the benchmark ledger.
- CI runs the browser suites in Playwright's container image for the locked Playwright version, which already holds the browsers and their system libraries. A slow Ubuntu package mirror no longer holds a browser check past its 15-minute limit.

## 1.0.0-alpha.34

### Breaking

- Expressions read a declared value only as `$name`, as the proposal specifies. A bare word inside an expression is now a keyword literal: `from:title="count"` sets the text `count`, and `{ label: name }` holds the keyword `name`. Add `$` to every reference in `from:`, `class:`, `style:`, `.prop`, `expr:value`, `<computed from>`, `$if`, `$when`, `$where`, `$limit`, `$key`, `$value`, `$html`, the `$each` list, the `$with`/`$match` subject, and `{…}` text. Loop items, `as` aliases, declaration and handler names stay bare.
- `bind:` and `<set name>` are path fields, not expression fields, and are written without `$` (`bind:value="search.query"`). A bracketed segment inside a path is an expression: `rows[$selected].name`. `$sort` keys are unchanged.

### Changed

- Every HTML Next package now requires Node `>=22.22.2 <23 || >=24.15 <25` (previously `>=22.13 <23 || >=24 <25`), the Node 22 and 24 releases that jsdom 30 supports. 1.0.0-alpha.33 already uses jsdom 30 for server rendering.
- A component slotted into a slot that is closed at first render lowers when the slot opens, and a slot that closes and renders again re-inserts the lowered component rather than its raw invocation. Hidden slotted content creates no instance or bindings until a slot renders it.
- A consumer's `<template slot>` renders lazily for every slot, including one that exposes no props. Previously such a slot inserted the inert `<template>` and its content never rendered. The children render in the consumer's scope only while the slot renders, afresh each time, and nothing inside is created, fetched or bound while the slot is hidden. `host.slots` lists the elements the template renders while its slot renders, and none otherwise; for a slot with props it previously listed the `<template>` itself. Plain projection stays eager.
- The quick start, counter example, and `@nextwebwg/html-next` README reference state with `$` (`{$count}`, `expr:value="$count + 1"`).
- Builds compile every component to direct DOM code with the live runtime's semantics: controllers, state, computeds, `$if`, `$match`, keyed and unkeyed `$each`, `$html`, props, slots, component invocations, declared data and contexts. The `experimentalDirectExtend` option and the general-runtime fallback are removed, and the build manifest no longer has a `directExtend` field. Compiled roots are visible to `getComponentHost`, `inspectInstance` and `serializeRenderedForm`, and hydrate live.
- Components that the smaller static, primitive-state and scalar-prop emitters compiled now render exactly as live does. Slot ranges are marked, prop validity uses live's messages and validity API, and inspection and hydration see them. Such a component alone bundles about 6.9 KB gzip of shared support, or 11.3 KB with props, paid once per application.
- A controller's write through `host.state` into a computed or context value, nested writes included, is refused with a read-only warning, as in the live runtime.
- Compiled components follow the live runtime's slot rules. A consumer's `<template slot>` renders only while its outlet renders, `host.slots` lists what it renders, and a component projected into a slot is created only once a slot places it.
- A compiled component bundles only the type checks its declared props and events use, not the type-expression parser, literal parser, unused formats or color keywords. Live type checks are built from the same combinators and are about 10% faster.
- A document has one MutationObserver for connection tracking, shared by the live runtime, compiled components and the React, Svelte and Vue targets. Bound `<select>` elements in the Svelte and Vue targets share one observer per document for their option lists.

### Added

- A structured attribute value accepts bare keywords as keyword literals, checked against the declared type: `<state value="{ mode: compact, tags: [red, blue] }">`.
- `html-next-check` reports warnings as well as errors. `HT022` warns when a bare keyword spells a name in scope (did you mean `$count`?). Warnings carry `severity: "warning"` and leave the exit status at `0`. `checkConversion` passes them to an optional `onWarning` callback.

## 1.0.0-alpha.33

- Simplify the public performance documentation and package READMEs.
- Server rendering uses jsdom 30.0.1 (previously 27.4.0). jsdom 30 declares Node `^22.22.2 || ^24.15.0`, narrower than HTML Next's `>=22.13 <23 || >=24 <25`.
- `@nextwebwg/html-next-unplugin` depends on vue-tsc 3.3.12 (previously 3.3.11).
- Generated React components typecheck in TypeScript 6+ projects that do not declare `*.css`, and the unplugin's generated declarations no longer import stylesheets.
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
