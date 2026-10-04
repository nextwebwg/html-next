# Conversion requirements

What the HTML Next framework converter must produce. The converter is tooling built on the
Declarative Components specification, not part of it.

Framework conversion translates a Declarative Components application or library graph into Vue,
React, Svelte, or Solid components while that target owns rendering, reactivity, lifecycle, and hydration.

## Inputs and graph boundary

The converter receives application entries or component-library entries, a target framework and
supported version, and output/package settings. It follows the same component, controller, style,
and static module graph as the native build.

Unknown runtime component edges require a declared target-native dynamic import, a universal
interop boundary, or a build diagnostic. The converter records the target and graph boundary in its
output inventory.

## Capability contract

Generated target components must preserve the shared semantic model: native root behavior,
projected content, properties (as attributes), events, methods, declared type behavior, state results,
requests, styles, lifecycle, controller behavior, and hydration outcome.

Acceptance is based on the component's appearance and runtime behavior, including controller
connect/disconnect calls and cleanup. Each framework may use its own DOM and SSR representation,
provided its output can hydrate into the equivalent functioning component. Node-object identity
and identical serialized SSR markup are not independent acceptance criteria. Tests should verify
the behavior at stake, such as focus, selection, edited control values, event delivery, and cleanup.

Target-native conventions may shape private implementation and generated source. They must not add
wrapper elements, change public names, substitute framework-only event semantics, or make target
objects part of the component's portable public contract.

## Runtime ownership

Vue, React, Svelte, or Solid owns its normal render scheduling, reactive dependency tracking, list
reconciliation, component lifecycle, SSR attachment, and hydration. The converter expresses the
normalized component plan through those facilities.

Converted output has **no runtime dependency on HTML Next**: it imports the target framework,
feature-specific generated helpers, and the component's own modules (its controller and preserved
ordinary modules), never an HTML Next package or live runtime. The generated `$html` helper also
imports `parse5` for deterministic server-side fragment parsing. Svelte output with style bindings
uses `cssstyle` and the public `css-tree/parser` entry for server CSSOM operations. A generated
helper package maps its server entry to a browser entry through the standard `browser` field;
client bindings use the actual element's `classList` and `CSSStyleDeclaration` directly. HTML Next either runs a component
itself or converts it; once converted, it is gone. Whatever the target cannot express directly is
part of the generated output.

## Output artifacts

Application conversion emits target application entries, generated components, target-native
styles or imported CSS, controller adapters, types, static assets, and an inventory.

Library conversion emits independently consumable component entries, package exports appropriate
to the target, declaration files, styles, controllers, preserved ordinary modules, and dependency
metadata. The inventory's `package.dependencies` lists feature-specific runtime imports such as
`parse5` for `$html`, and `package.peerDependencies` names the target framework. Publishers merge
these fields into their package manifest and remain responsible for dependencies imported by their
own controller modules. A multi-target package may mark each framework peer optional when its
subpaths are independently usable. Generated source must remain compatible with the target's
standard compiler and bundler pipeline.

## Failure behavior

Conversion reports source-located diagnostics for unsupported target versions, unrepresentable
language semantics, unsafe resource edges, output collisions, and target package conflicts. It must
not silently approximate behavior.

Runtime failures preserve the shared public error, event, type, cancellation, and cleanup
contract. Target error boundaries may observe those failures but cannot replace required component
events or leave effects, requests, or controllers active after disposal.

An incompatible React server root is a hydration diagnostic exception, not a component-thrown
HTML Next error. The application calls React's `hydrateRoot` and may observe recovery through its
`onRecoverableError` option; generated components do not add an `HR005` wrapper or take over
hydration. Matching server markup, the recovered render, and subsequent behavior must still meet
the converter's parity requirements.

## Optimization boundary

The converter should use target-native rendering, reactivity, lifecycle, event, list, and hydration
facilities before adding bridge code. It may specialize against the complete application or library
graph and target version.

Optimization must preserve portable public behavior. Framework package cost, generated application
code, and HTML Next bridge cost are separate quantities; excluding the target framework from the
bridge figure must be explicit.

Primitive selection is a semantic check, not a syntax translation. For each target feature, verify
who owns the DOM value, which event updates state, when a model change writes back, what SSR emits,
and what hydration does to a native edit. For HTML Next `bind:value`/`bind:checked`, a control
keeps its native edit through unrelated renders; a changed bound value retakes control. Vue's native
`v-model` makes JavaScript state authoritative over the control, so the Vue output uses a custom
directive on the native element plus ordinary DOM events. Vue's component `modelValue`/`update:modelValue`
convention remains appropriate at the *component API* boundary, not as the internal control
directive. The application/library hydration test asserts that distinction in generated output
and exercises both sides of the write rule across three engines. React's controlled `value`/
`checked` and one-time `defaultValue`/`defaultChecked` each cover only part of the same contract;
its adapter must prove a target-appropriate bridge before it can pass this gate. Svelte and Solid
need the same semantic audit when their adapters are implemented; matching binding syntax alone
is not evidence of parity.

## Measurement contract

Each result names the framework and version, application or library graph, included capabilities,
SSR and hydration mode, production compiler settings, and bundle boundary.

Measurements report generated code, HTML Next bridges, target framework/runtime, total production
output, build time, server render when applicable, initial client mount, hydration, reactive
updates, keyed changes, and disposal. Library measurements include representative single-entry and
multi-entry consumer bundles.

## Conformance scenarios

1. Convert one shared fixture graph to Vue, React, Svelte, and Solid and compare native roots, projection,
   props, events, methods, state results, declared types, native form behavior, styles, and diagnostics.
2. Server-render and hydrate each target while preserving specified form edits, focus, and
   selection.
3. Exercise target-native reactive updates, keyed reorders, controller cleanup, and request
   cancellation without importing the general live browser runtime.
4. Bundle one and several entries from a converted library and verify stable exports plus shared
   bridge deduplication.
5. Reject a semantic gap the target adapter cannot preserve with a source-located conversion
   diagnostic rather than emitting an approximation.

## Vue parity gate status

The browser parity suite is `packages/html-next/tests/vue-parity.test.ts`. Run it with
`corepack pnpm test:targets`. It compiles real Vue single-file component output, mounts the same
authored components with the live HTML Next runtime and Vue, and compares browser probes and exact
screenshots in Chromium, Firefox, and WebKit before and after interactions. It also converts each
successful live-runtime conformance example and compares the runnable examples in all three engines.
The same target command now runs every public-converter Vue parity fixture. A separate fixture
converts all 35 successful shared conformance examples through both the application and library
entry artifacts, then compares the live runtime's expected behavior and exact pixels in Chromium,
Firefox, and WebKit (210 browser cases). Each case also runs through Vue's SSR compiler: the
server markup is compared before hydration, then hydrated and compared again for behavior and
pixels. This verifies that the public graph/packaging path does not silently lose behavior
covered by direct component generation.

The shared corpus now includes an SVG subtree with bound `viewBox` and `gradientUnits`, SVG
descendants, and an HTML child inside `foreignObject`. The public converter asks the HTML parser
for SVG's canonical attribute spelling at build time and makes Vue write those bindings as
attributes. Application and library output preserve namespaces, values, SSR/hydration behavior,
and exact pixels in all three engines.
The Node source parser also follows HTML parser recovery for malformed-but-recoverable markup,
such as duplicate attributes. It no longer rejects a resource solely because parse5 reports a
recoverable parse error; a missing stable carrier source range remains a build diagnostic.

All 35 successful live-runtime conformance examples now
convert, including `$html` through a feature-specific safe-markup helper. Every example
matches the live runtime's browser behavior and pixels, after excluding target-owned styling
markers from the DOM comparison. Additional interactive fixtures compare rendered pixels and
behavior at two checkpoints in all three engines. They cover basic requests, cancellation, and per-reference typed data reads.
A root-level `$with` keeps its single native root and evaluates its alias reactively in both the
live runtime and converted Vue; the shared public-converter fixture compares its initial output
and a handler-driven state change, including pixels, in both graph modes and all three engines.
A public-converter fixture pairs the remaining read lifecycle: JSON and text bodies, relative URLs,
array query parameters, failure with stale-value retention, polling recovery, request abort, debounce,
and disposal. Dedicated application/library fixtures now pair edited form controls, focus,
selection, validation, external form association, and select/reset behavior through SSR and
hydration. The graph fixtures pair the individual feature areas; they do not prove every possible
combination of those features.

All 26 static invalid-definition cases in the shared browser conformance corpus now retain their
source-located HTML Next diagnostic code through the public converter in both graph modes, without
writing partial output. A separate browser fixture pairs missing required props (`HC020`), invalid
typed props (`HR002`), numeric string conversion, rejected updates, and recovery with matching
pixels and behavior in all three engines. The generated typed-prop helper is emitted only when a
component declares props and is differentially tested against the shared type parser. The public converter also retains
the graph loader's source-located `HL007` diagnostic when two resources declare the same tag,
without writing partial output in either graph mode.
The parser now reports `HT021` before either runtime or converter output for a root `$if`, `$each`,
standalone arm, hostless `<template>`, or `<slot>`: those roots cannot guarantee the proposal's
single native or delegated element. Root `$with` and valid root `$match` remain supported.
Additional public-converter cases cover malformed controller specifiers and handler steps
(`HC022`/`HC023`), `$match` aliases (`HT017`), references (`HT019`), and style binding targets
(`HT020`) in both graph modes. Style diagnostics `HY001`–`HY003` likewise retain their original
source-located codes rather than becoming generic target-conversion failures. Typed structured
state is now rejected by `:host-state()` in both the live runtime and converted output.

The diagnostic audit separates authored failures from defensive API guards. Authored-source
failures use the shared parser and style validator; the browser corpus and public converter check
the same codes. Runtime failures for typed props/events, duplicate keys, hydration, computed cycles,
scoped slots, recursion, missing context, and controller loading/exports have three-engine
differential fixtures in both graph modes. Graph, controller-resource, collision, and target-version
errors are checked before output is written. Duplicate live registration (`HR001`) and duplicate
build-graph tags (`HL007`) both reject the invalid graph. `HB001`, `HR003`, `HL008`, and `HS005`
guard direct runtime APIs or unreachable post-validation states, not authored Vue features;
`HV001` reports unreadable cross-origin CSS in the separate HTML Forms validity-style shim.
The target's `HT030`, `HT031`, `HT033`, and `HT034` guards require a malformed programmatic
definition after parsing. No authored diagnostic route remains listed as unpaired in the strict
Vue gate.
An exported package component subpath resolves through the consuming project's ordinary
`package.json` exports and joins the converted graph. Missing packages and unexported subpaths
instead report source-located `HL002` at the importing definition, with no partial output in
either graph mode.
Public conversion also preserves `HL003` for dependencies outside the package, `HL005` for
controllers outside it, `HL006` for empty component links, and `HL009` for unreadable component
resources. Both graph modes reject these inputs before writing output; a missing resource is
located at its requested URL, while invalid links and controllers are located at the importer.
Controller graph reads now check each relative import against the approved root before opening
it, including symlink targets. Missing controller files, missing relative imports, and escaping
imports produce source-located `HTC001` conversion diagnostics without partial output in both
graph modes.
Literal relative `import("./module.js")` edges are copied and run from converted controllers;
an `import(specifier)` whose target cannot be known at conversion time instead receives a
source-located `HTC001` diagnostic before output is written.
Missing logical context now emits the same `HR009` diagnostic code, name, and message as the live
runtime; a public-converter browser fixture checks application and library output in all three
engines. A separate public-converter fixture checks valid context through projected slots and
nested providers, comparing nearest-provider updates and exact pixels in both graph modes and all
three engines before and after SSR/hydration.
Converted keyed lists now check duplicate computed `$key` values before Vue reconciles the rows.
A local Vue component boundary retains the last valid row VNodes while a narrow child reporter
raises `HR004` through Vue's normal error propagation, including ancestor `onErrorCaptured` and
the app error handler. A later valid update recovers without losing the list root. The
public-converter fixture compares the exact code, name, message, post-error DOM, recovery behavior,
identity, and pixels in both graph modes and all three engines.

A separate public-converter graph fixture now imports the emitted application and library entry
artifacts, mounts a parent plus its statically imported child through Vue's SFC compiler, and
compares rendered behavior and exact pixels before and after a state change in Chromium, Firefox,
and WebKit. It also compiles both components for Vue SSR, compares server markup before hydration,
then hydrates and repeats reactive and event interactions with behavior and pixel checks in all
three engines. The same fixture checks initially active `:host-state` styling, its reactive change,
and `:slotted(strong)` styling on projected content before and after hydration. This closes the
representative nested-graph hydration gap; combinations involving
other feature areas remain covered by their own parity fixtures or remain in the strict gate.

A real-element root `$match` now retains its native wrapper and switches only its selected child.
The public Vue converter emits that wrapper with Vue's conditional children; the browser parity
fixture checks root bindings, scoped `:host` and child styles, optional match scope, behavior, and
pixels across all three engines. The live runtime also adopts the selected child in place when
hydrating its rendered form, so the wrapper and child keep their DOM identities.

Form parity fixtures now cover text, checkbox, radio, select/option, and number bindings; native
validity while a user types; `FormData`; a component control inside an author-owned form; projected
options; multiple selection; and keyed option changes. A public-converter application/library
fixture additionally covers an input-root component linked to a separate form by `form` ID,
native invalid/valid submission, typed email validity, live value binding, and exact pixels in all
three browser engines. The input-root fixture also runs Vue's SSR compiler, compares server
markup before hydration, and repeats invalid/valid submissions, `FormData`, validity, and pixels
after hydration in both graph modes and all three engines. A companion fixture covers a select-root component linked to an external
form, including option selection, `FormData`, required validation, submission, native reset, and
exact pixels in both graph modes and all three engines, before and after Vue SSR hydration.
It caught a selection loss during default restoration: the generated bridge now snapshots all
selected options before changing any authored `defaultSelected` values, then restores the live
selection. The radio case caught a Vue `v-model`
mismatch: `bind:checked` is boolean,
whereas radio `v-model` would write the radio's string value. The converter now uses a
feature-specific native-control directive and DOM events for input, textarea, and select bindings,
so an unrelated Vue render does not overwrite a user edit or change native dirty-value validity.
Vue's `v-model` treats state as the sole source of truth and would reassert stale state on select
updates; HTML Next instead lets an edited control retain its native value until the bound model
changes. A wrapper-free Vue component renders select options through VNodes so authored, fallback,
projected, null-to-empty, and read-only options receive the correct `selected` state in optimized SSR.
The SSR helper also receives the native `multiple` state: a null two-way value selects the
empty-valued option for a single select but no options for a multiple select, matching the live
runtime and native `FormData` behavior. A single select stringifies an array as one native value
(`['b', 'c']` matches an option with value `b,c`); it does not select each array member as a
multiple select would. A `.value` property assignment on a multiple select also uses the native
scalar setter and targets one option; only `bind:value` on a multiple select treats an array as
the selected-value set.
The direct browser parity suite also toggles a select's `:multiple` binding reactively and checks
selection, `FormData`, state output, and pixels in all three engines.
For ordinary `:value` and `:checked` attribute bindings, the converter uses Vue's `.attr` modifier,
including explicit empty-or-absent values for boolean attributes, so native dirty-value and
dirty-checkedness rules apply. For `.value` and `.checked` property bindings, the control directive
is the sole live-property writer; it preserves an authored form-reset default and does not reassert
an unchanged model after a native edit. The converter does not emit a competing Vue `:value`
property binding and then repair its effect after the fact.
The select bridge observes option-list changes and reapplies the bound value after Vue has patched
the options, including when the model itself is unchanged; unrelated renders leave a native edit alone.
The application/library hydration fixture runs the generated component through Vue's SFC SSR
compiler, then compares server-rendered control state and pixels before hydration, native reset
before hydration, pre-hydration edits, focus and selection,
later unrelated renders, real model updates, native edits after those updates, and pixels in all
three engines. Child-node object identity is not a parity criterion by itself. Initial and reactive option selection also exposed live-runtime write-order bugs,
now covered by browser parity checks. Further form and hydration edge cases remain to be paired.
A separate public-converter form-model fixture checks text, checkbox, radio, single select, and
multiple select together. It compares native edits before events, an unrelated reactive update,
event-to-model writes, keyed option replacement, model-driven reselection, `FormData`, validity,
and exact pixels in both graph modes and all three engines. It also compares native `form.reset()`
after model changes and another unrelated render. Hydration and form-model fixtures also
exercise an in-place multiple-selection model change: the hydration guard compares an array
snapshot, so an unchanged array identity does not disguise changed option values.
Vue SSR encodes bound values as `value`, `checked`, textarea content, or option `selected`
defaults to show the initial state before JavaScript runs. Native `cloneNode()` and HTML
serialization omit dirty control properties, so HTML Next's rendered-form serializer now mirrors
those properties into the browser's own serializable attributes and textarea content. Temporary
`data-html-next-form-defaults` metadata records any displaced authored reset default, including
for projected options; hydration consumes and removes it while retaining current values and
pre-hydration edits. The Vue bridge likewise restores authored defaults after claiming the DOM.
The fixture verifies both static server output and `form.reset()` before hydration, then explicit
authored defaults, later model changes, reset behavior, and pixels after hydration in all three
engines. A read-only select `.value` assignment now runs after options exist, and both the live
runtime and Vue output use native string coercion (`null` becomes `"null"`) for that property;
`bind:value` retains its distinct empty-value normalization.
The parity fixtures use explicit control borders and backgrounds for screenshot comparisons;
native control values, validity, focus, selection, reset, and submission remain browser-owned.

The keyed nested-component fixtures compare reorder, removal, and restoration behavior and pixels
in all three engines. They check that a visible native input edit survives a reorder, a changed
child prop updates the row, a removed child cleans up once, and a restored child connects once.
A companion SSR/hydration path verifies the initial keyed
rows and the same reorder, removal, and restoration outcomes and pixels in both graph modes and
all three engines. It does not make child-node object identity a parity requirement.

A separate public-converter controller fixture compares a real copied module in Chromium,
Firefox, and WebKit. It covers state writes, controller-local signals and computed values, effects,
an exposed method, pixels, root replacement without reconnection, ordinary unmount, asynchronous
setup that completes after unmount, external removal and reinsertion of the same root, and an
in-tree move that must preserve the connection. The Vue host adapter uses one native
`MutationObserver` per document for external connection changes; Vue mount/unmount hooks alone
do not report direct DOM moves.
The same copied controller also runs through Vue SSR and hydration from the emitted application
and library entries. In all three engines, the hydrated controller connects once, reacts to a
root-switching state update, and cleans up once on unmount with matching behavior and pixels.
The fixture also calls a declared method whose controller export is absent. The generated Vue
method now rejects with the runtime's `HJ003` diagnostic rather than an incidental JavaScript
`TypeError`, with the exact name, code, and message checked in all three engines.
A separate public-converter fixture checks the runtime's specific not-ready `TypeError` for a
declared method without a controller, also in application and library mode across all three engines.
For a controller module whose default export is not a function, the Vue host validates at connection
time rather than allowing a browser-specific call error. A public-converter fixture compares the
live loader's `HJ002` name, code, source, message, retained root, pixels, and reconnection report in
both graph modes and all three engines.
Controller modules are imported on connection, not eagerly during bundle evaluation. If import or
module evaluation fails, a public-converter fixture checks the live loader's `HJ001` name, code,
source, message, retained root, pixels, and reconnection report in both graph modes and all three engines.
Declared computed values guard cyclic reads before Vue can return an in-progress value. A
public-converter fixture compares self-referential and mutual cycles against the live runtime's
`HR006` diagnostic in both graph modes and all three engines.
When a component graph has an invocation cycle or a path beyond the live runtime's nested-lowering
limit, the public converter emits an `HR008` depth guard. Ordinary graphs omit it. A recursive
fixture checks the permitted boundary, the over-limit diagnostic, SSR output, behavior, and pixels
in both graph modes and all three browser engines.

A public-converter slot fixture compares named/default projection, row-dependent dynamic slot
names, fallback changes, and root-switch output and pixels in application and library mode across
all three engines before and after SSR/hydration. Scoped-slot fixtures also compare consumer lexical scope, slot-prop shadowing,
server output, hydration, and later reactive updates. An additional public-converter fixture
checks that an absent scoped-slot consumer renders fallback content for both static and dynamic
slot names, with matching pixels in both graph modes and all three engines. Node-object identity
across an explicit root switch is not itself a parity criterion; the gate is the behavior HTML Next
intentionally specifies.
When a converted consumer assigns an ordinary element to a scoped slot instead of using its
required `<template slot="…">` carrier, the generated receiver checks Vue's native slot VNodes
at that outlet and raises the live runtime's `HR007` diagnostic. A public-converter fixture checks
the exact name, code, and message in both graph modes and all three engines. An absent consumer
still renders the authored fallback.

Event parity fixtures compare capture, propagation, cancellation, once-listener removal, self and
keyboard filters, declared event flags, and nested component listeners against explicit native
outcomes in all three engines. The public-converter controller fixture also checks that a canceled
dispatch returns `false` and invalid declared detail raises `HR002` before delivery. The
application/library graph fixture proves that filters run before `.stop` regardless of authored
order, including for declared events on nested components, and that `on:click.right` on a component
invocation still listens for a native `click`. Vue's own modifiers can stop a filtered
child event or reinterpret `click.middle`/`click.right`, so the converter retains only native
listener options and applies the other modifiers to the original DOM event. Declared component
events remain native `CustomEvent`s on the lowered root; Vue emits are used only for `v-model`
updates. A public-converter matrix exercises every supported modifier, capture ordering, and
representative combinations in application and library mode in all three engines, comparing
dispatch outcomes, state, and exact pixels after both a fresh mount and SSR/hydration. Invalid
modifier bindings retain their source-located
HTML Next `HT010` diagnostics. Declarative connection hooks are deferred from Level 1.

`$html` uses a common sanitizer contract. The browser runtime and generated Vue helper parse
with the HTML fragment parser and apply the HTML Sanitizer API's safe-default allowlist; the
server implementation uses `parse5` and the same allowlist. Neither the live runtime nor converted
Vue output calls native `setHTML()`, even when available: Firefox currently reorders malformed table content differently
from Chromium, WebKit, and `parse5`, which would make output browser-dependent and break
deterministic SSR/hydration. Native `setHTML()` remains a differential conformance oracle.
The converted helper renders sanitized Vue nodes, so dynamic content receives scoped styling and
reactive updates without a raw `v-html` sink. Cross-engine pixel and behavior parity is covered;
a direct SSR-to-hydration test also verifies that Vue retains the server-rendered root and sanitized
child nodes before a reactive update.

The public converter now avoids embedding local `file://` definition URLs in generated Vue data
requests. A component-relative source needs `publicRootURL`, the browser URL corresponding to the
conversion root; otherwise conversion fails before writing output. A root-relative source uses the
page's browser origin without that setting. Public-converter fixtures compare both URL forms,
string and JSON responses, reactive and timed reads, cancellations, failures, rendered pixels, and
resolved data in Chromium, Firefox, and WebKit. A separate SSR/hydration check uses the emitted
application and library entries: server rendering starts no browser requests, and hydration makes
each relative and root-relative read once with matching output and pixels in all three engines.
The data lifecycle also runs after hydration in both graph modes: a failed read retains stale
data, polling recovers, a newer key aborts the prior request, and unmount stops polling. Behavior
and pixels match the live runtime at each stage in all three engines.

`HTMLNEXT_REQUIRE_COMPLETE_VUE_PARITY=1 corepack pnpm test:targets` activates the strict gate; it
must pass, with the explicit gap inventories empty and all feature areas paired, before a claim of
complete Vue parity. Ordinary `test:targets` keeps the corpus
and feature fixtures running while new features are added.
