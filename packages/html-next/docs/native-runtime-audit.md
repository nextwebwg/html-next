# Native runtime audit

The browser runtime composes Web Platform facilities into the behavior defined by Declarative HTML
Components. This ledger identifies the platform foundation for each subsystem, the code that still
belongs to the reference implementation, and the evidence or decision required to keep it. The live
distributable supports arbitrary dynamic component graphs. Native builds analyze a complete
application or library graph and share the support required by that graph. Framework converters use
their target runtime for equivalent behavior.

The current live-loader attribution comes from `pnpm measure:runtime` under
`live_distributable`. Values are minified raw bytes inside the current 164,747-byte bundle; its
complete gzip size is 54,418 bytes (gzip level 9, measured October 6, 2026). Compressed bytes cannot be
attributed cleanly to individual modules.
The `native_build.capabilityFixtures` group reports isolated generated attribution.
`pnpm audit:native` records relevant platform surface support and the native sanitizer's output in
the installed Chromium, Firefox, and WebKit builds.

## Inline text reads

The native HTML parser already creates inert text nodes in context-valid elements, including table
cells. `Document.createTextNode()` and `Text.data` provide escaped text output and preserve sibling
markup and node identity. The remaining gap is recognizing authored `{expression}` segments and subscribing
them to the existing `$value` effects. The shared parser records literal segments
and compiled expressions within each authored text node; the live runtime and Node renderer update native text nodes, while
framework targets lower the same reads to their own escaped-text rendering. Generated scalar
components use their existing specialized dependency updates. No HTML source replacement or
runtime scanning of returned values is involved. Identifier validation reuses CSS Syntax's
ident-start code points, with digits as continuations and without dashes or identifier escapes.

## Intl expression formatting

Native `Intl.NumberFormat`, `DateTimeFormat`, `ListFormat`, `RelativeTimeFormat`, `DurationFormat`,
`DisplayNames`, and `PluralRules` own locale negotiation, option validation, and localized output.
The remaining gap is selecting a formatter from the declared HTML type, adapting serialized typed
values, and connecting formatting to existing expression dependencies and invalid-value retention.
`format.ts` supplies one native adapter used by the interpreter and emitted only into generated
Vue/React components with authored formatting. The generated helper has no live-parser dependency.
Native number/date range methods and structured parts support `formatRange()` and `formatParts()`.

Native formatter objects already support repeated values and parts/ranges. The adapter retains up
to 128 instances per module, keyed by constructor identity, locale and sorted primitive options;
FIFO eviction bounds retention. Values, relative-time units and plural messages are never cached.
Mutable/coercible options and oversized keys bypass reuse, preserving native validation and side
effects. Browser-default locale keys include `navigator.language`. Instant formatting without an
explicit time zone also bypasses reuse because the platform has no cheap notification/query for
default-zone changes; civil values use their fixed UTC anchor. Generated Vue/React factories live
at module scope, so rerenders and instances of the same component share them. Components without
formatting emit no factory. No additional observers, scheduling, or browser polyfills are added.

Civil `date`, `time`, and `datetime-local` values have no zone. Their native adapter anchors fields
in UTC internally and removes unavailable zone-name parts; it does not shift the clock or show an
invented UTC label. Global `datetime` values retain their instant meaning. CSS percentages supply a
numeric ratio; CSS durations supply balanced duration fields. Plural message selection adds only a
category lookup and formatted `#` substitution. Other native options keep their native names and
semantics. Explicit locale/time-zone arguments make SSR and client preferences reviewable.
Cross-engine evidence lives in `formatting-fixture.ts`, Vue/React parity, and server hydration tests.
Node 22 lacks `Intl.DurationFormat`; the isolated server worker imports FormatJS's maintained
polyfill, which preserves native implementations where available. The browser graph does not
import it. Standalone framework SSR consumers configure this polyfill in their own server entry.

## Complete live inventory

The production browser entry currently contains 164,726 attributed minified raw bytes plus 21
bytes of bundler framing. Every contributing module belongs to one audited responsibility; an
unclassified dependency fails `measure:runtime`.

| Responsibility | Minified raw bytes | Native foundation under review |
| --- | ---: | --- |
| Reactive execution | 87,584 | DOM identity and updates, events, microtasks, connection state, Fetch, cancellation, native ESM |
| Types and validation | 29,106 | JavaScript primitives, Trusted Types, and platform value objects |
| Parsing and contract | 32,764 | Browser-parsed inert DOM, attributes, template contents, element/property reflection |
| Style and content policy | 8,834 | CSSOM, `@scope`, template parsing, safe HTML sinks |
| Component resources | 3,908 | URL, Fetch, import maps, native ESM, CORS, CSP |
| Discovery and lifecycle | 2,530 | Shared MutationObserver, selector matching, node identity, connection state |

These groups are cost attribution, not separately shipped runtimes. The complete live distributable
contains all of them for arbitrary later graphs.

| Subsystem | Platform foundation | Reference-library layer | Current evidence and status |
| --- | --- | --- | --- |
| Component HTML parsing | `<template>`, the HTML parser, DOM traversal, native element/property introspection | Proposal grammar, declarations, diagnostics, and contract construction | The live parser reads the browser's inert DOM directly instead of cloning a parse5-shaped tree. Shared parsing owns definition safety, so live mounting avoids a second recursive safety traversal. Attribute reads use `getAttribute()` and traverse the browser's `NamedNodeMap`; traversal-only child passes iterate native `NodeList` objects. A 200-element attribute-read/scan microbenchmark measured the native path at 3.8x in Chromium, 3.9x in Firefox, and 4.1x in WebKit; source-adapter parity passes all three engines. Those historical parser cuts removed 534 raw and 101 gzip bytes from their comparison baseline while browser bundles contain zero `parse5` and zero generated DOM-property inventory modules. |
| Component discovery and lifecycle | `MutationObserver`, selector matching, `Node.isConnected`, native `connect`/`disconnect` events | One realm-global document subscriber hub and one component lifecycle coordinator | Owner-approved shape: definition changes update one cached tag selector; added scopes are queried against it, and matching elements resolve through the registry map. Mutation batches allocate work only for actual matches instead of every registered component. Removed scopes are queried only for marked component roots, and connected instances own their cleanup and reconnect work. Definitions retain only runtime-consumed data. |
| Reactive scheduling | Native events, property access, `queueMicrotask()` | Dependency collection for proposal state, computed values, and effects | `reactivity.ts` contributes 7,740 raw live-loader bytes. The measured scheduler resolves local cells once, avoids empty cleanup writes, batches uncontended fan-out, skips sorting already ordered queues, and bounds cycles by propagation depth. Static, numeric state, numeric computed, and scalar-prop generated components compile this layer away. Retention for dynamic live expressions remains pending owner review. |
| Expressions | JavaScript primitives and native string/number operations | CSP-safe parser, typed operations, missing-value semantics, dependency paths, and diagnostics | `expression.ts` contributes 13,249 raw live-loader bytes. Its direct regex/precedence parser eliminates token arrays and improves the measured unique-compile and compiled-evaluation workloads while preserving the public AST. Generated output emits only expressions whose semantics it can prove; all other shapes retain the interpreter. |
| Public props | Invocation attributes, native scalar conversion | Declared type boundary, explicit-only `data-*` reflection, and reflection batching | Props are the invocation's attributes: initial configuration, as for native elements. The lowered root records them as `data-*`, which hydration reads and nothing observes afterwards; later changes arrive reactively through a framework's props. No element properties are added. Direct scalar and enum props produce a 2,045-byte gzip fixture. The contract and type boundary share one recursive-freeze implementation. |
| Keyed lists | `Map`, comment range markers, `ParentNode.moveBefore()` where implemented, and `insertBefore()` compatibility | Duplicate-key diagnostics and a longest-increasing-subsequence choice of which blocks to move | Owner approved the LIS layer for keyed `$each`. A distant 1,000-row swap moves two blocks instead of roughly 1,000. Chromium and Firefox use state-preserving `moveBefore()`; WebKit currently uses `insertBefore()`. |
| Declared reads | `fetch()`, `URL`, `URLSearchParams`, `AbortController`, response body readers, and timers | Parameter dependency updates, debounce/poll policy, stale-result suppression, state projection, and an optional application adaptation hook | Response-schema enforcement is not a core component concern. The runtime publishes decoded values directly unless a low-level `DataResource` consumer supplies an `adapt` callback; JSON Schema and domain codecs remain optional application or build-tool adapters. |
| Native form participation | Native `<form>`, form ownership, successful controls, constraint validation, and submission | Preserve component-rendered controls as ordinary DOM controls | Request enhancement is available from `@nextwebwg/html-next/forms`; the component runtime does not import or re-export it. |
| Declared type enforcement | Attributes, native scalar conversion and constraint validation | Parse and serialize structural types explicitly authored by a component contract | Type enforcement remains at prop, event, and other declared contract boundaries. HTML formats such as email, URL, date, color, identifier, and token syntax use native-control constraints or an opt-in validation adapter rather than being universal contract terminals. External response validation is available through `DataResource.adapt`; opt-in validation utilities remain package APIs but are not installed by the browser runtime. Those historical boundary corrections cut 20,854 minified raw bytes and 6,147 gzip bytes from their comparison baseline. |
| Dynamic HTML content | `<template>` fragment parsing, DOM traversal, Trusted Types-compatible sinks | Allow/block policy for `$html` content | Owner-approved for the current baseline: retain the `sanitize.ts` adapter (1,133 minified raw bytes), with its separate `sanitizer-default.ts` policy (2,907 bytes) across engines. Definition validation now imports this module's URL-attribute and executable-scheme policy instead of carrying a second copy. Standard `setHTML()` exists in the tested Chromium and Firefox builds but not WebKit. Its safe default also removes the fixture's ordinary image and form, which the current policy preserves. Revisit when every target engine exposes equivalent policy control. |
| Component styling | CSS parser/CSSOM, selectors, cascade, `@scope`, native style elements | Live-source selector transformation and portable generated-target scoping | The live runtime requires native `@scope` (Chrome 118+, Safari 17.4+, Firefox 146+) and uses a scope-only compiler path. Generated targets retain provenance-attribute scoping for older engines. Native validity selectors retain their browser meaning; the component transformer no longer expands them to private mirrored attributes. |
| Controllers | Native ESM, `EventTarget`, selectors, form collections, and cleanup callbacks | The uniform `ComponentHost` state/effect facade and lifecycle attachment | Controller modules load through native `import()`. The isolated controller capability fixture costs 37,973 bytes gzip because the native build includes the general runtime. The intended build shape is one graph-scoped host implementation shared by the application or library output. It keeps the full controller-facing contract while pruning implementation machinery the graph does not require. |
| Resource graphs and import maps | `URL`, `fetch()`, CORS, CSP, native module loading, and application import-map markup | HTML component dependency graph, duplicate-tag checks, import-map snapshot resolution, and application-selected live-scope enforcement | Same-origin roots remain inside the application origin. Cross-origin roots require an application-owned mapping; relative definition and controller entry edges cannot escape its mapped prefix, and component redirects are checked before registration. A polyfill cannot enforce the controller final-target rule because native `import()` has no pre-execution redirect hook; that check requires browser integration. Controller transitive imports remain ordinary ESM. Browsers expose no equivalent component-resource resolver, so the remaining authority layer is necessary. |
| Hydration and adoption | Existing DOM identity, selectors, control state, focus, and selection APIs | Matching server-lowered roots to definitions and attaching only authored behavior | Cross-browser tests preserve node identity and live form-control state. `pnpm measure:hydration` reports server-DOM adoption and fresh lowering separately while asserting identity, edit, focus, and selection preservation on every sample. A parent never binds a template-component invocation: its bound values stay that invocation's attributes until the component lowers, and its listeners, refs, and properties attach to the component's root when it does, in either adoption order, then re-run on each new root. |

## Native-build capability fixtures

Dependency membership uses native identity lookup. Ordered effects reuse their linked
subscriptions; small duplicate checks inspect at most eight consumed links before a wider miss
builds one execution-local `Set`. The runtime still owns read-to-consumer routing because DOM
observation does not expose authored JavaScript state reads. After reordered reads insert a new
subscription, membership is checked before consuming an old link so the same dependency is not
subscribed twice. Execution completion releases the membership index; conditional cleanup,
pause, and stop release obsolete subscriptions. Direct scalar native output compiles this layer
away; live components and generated general-runtime fallbacks share it.

Controller paths retain separate write guards for their destination types. Native `WeakMap`
identity associates writable facades with their existing reactive objects, so assigning values
returned by array filtering, concatenation, or swapping does not stack another reactive proxy
around an old controller guard. The next controller read applies its destination's guard.
Readonly facades are not registered as writable aliases: their barriers survive assignments
into writable state. Frozen values and native events keep their existing handling.

Repeated-region removal uses native `replaceChildren` when the removed blocks and outer
anchors occupy the entire parent, or `Range.deleteContents` for adjacent removed blocks.
Native operations supply the DOM mutation and lifecycle behavior; the remaining runtime
layer stops each block's effects and preserves ownership boundaries. Retained blocks and
foreign siblings split removal groups. A single removed block keeps the direct removal
path, and outer anchors retain their identity for later updates and hydration.

Fresh ordinary repeated regions cache a detached native DOM prototype and ordered binding-site
paths. Native `cloneNode(true)` creates each new block; existing attribute, text, content and event
helpers install its effects and listeners in authored order. Static construction and literal writes
occur once per definition/node and document. The cache is resolved at region initialization, outside
the row loop. Refs, properties, controls, resources, custom elements, namespaces, slots and descendant
flows retain ordinary rendering; existing server DOM retains adoption. No freezing, HTML sink or
additional observer is introduced. Per-instance values, guards and ownership remain dynamic.

| Authored feature | Gzip bytes (level 9) | Runtime shape |
| --- | ---: | --- |
| Static markup | 347 | Direct DOM creation |
| Numeric state and handler | 425 | Direct variables, native event, microtask update |
| Numeric computed state | 431 | Direct arithmetic in the same update |
| Scalar and enum props | 2,045 | Generated prop boundary and shared lifecycle helper |
| Keyed list | 38,079 | Shared general-runtime support |
| Declared read | 38,034 | Shared general-runtime support |
| Controller lifecycle | 37,973 | Shared general-runtime support |
| Controller keyed list, `directExtend` | 7,517 | Cloned blocks, `KeyedList`, compact type checks, generated controller host |

The fixtures isolate authored capabilities so regressions and fallback costs remain attributable.
They are not separate per-component runtimes. An application or library build combines the complete
input graph, deduplicates shared support, and emits one coherent native target. The first four
fixtures have hard size gates. The remaining fixtures expose current full-runtime fallbacks while
their build-scoped implementations and budgets are evaluated.

Native factories that use the general-runtime fallback own their structural bindings. Their shared
MutationObserver coordinator reports connection changes; the runtime renders `$if` and `$each`
regions and reconnects the same instance state. Framework adapters give structural ownership to
their framework renderer instead. The attachment path preserves this distinction, with Chromium,
Firefox, and WebKit tests covering native keyed updates, branch changes, and reconnect behavior.

## Direct-extend generated components (experimental)

`GenerationOptions.directExtend` (the unplugin's `experimentalDirectExtend`) compiles components
with a controller, declared state, `$if` and keyed `$each` to straight-line DOM code instead of the
general-runtime fallback. The direct path is meant to cover every feature the live runtime supports;
until it covers one, a component using it keeps the fallback unchanged, and the unplugin keeps a
whole graph on the fallback when any component in it needs the general runtime. The
generated module imports only the `generated-runtime` helpers its features use; the interpreter,
parsers, type system and formatter never reach it, and `measure:runtime` fails if they do. The
[compiled direct path](./compiled-direct-path.md) describes its architecture, coverage plan and
byte budgets.

| Need | Native mechanism composed | Remaining gap filled by code |
| --- | --- | --- |
| Build row and branch DOM | `createElement`/`setAttribute` once into a prototype, then `cloneNode(true)`; no HTML or Trusted Types sink | `buildTemplate()` spec walker |
| Find binding sites | `firstChild`/`nextSibling` getters | Paths computed at compile time |
| `$value` text | `Text.data` on the element's sole Text child; `textContent` for `""` and foreign content | `writeText()`: one guard; writes only when the converted text changed |
| Attributes, classes | `setAttribute`/`removeAttribute`, `classList.toggle(name, force)` | The interpreter's own `toAttribute`/`toText`/`truthy` conversions |
| Insertion | `insertBefore`; one `DocumentFragment` per run of fresh rows (row-by-row stays selectable) | Grouping fresh runs |
| Bulk removal | `replaceChildren(start, end)` when the region owns its parent, else `Range.deleteContents()` or `remove()` | Adjacency grouping; foreign nodes split groups |
| Moves | `moveBefore` with an `insertBefore` fallback, as the live runtime | Swapped ends, then the longest increasing run of retained positions |
| Controller contract | `Proxy` with shared traps per instance (one handler record per raw object and type), `WeakMap` cache | Compact declared-type checks (`conforms`) |
| Change notification | None native | Controller effects use the reactivity dependency graph; templates use root bits and written raw objects |
| Lifecycle | The shared document `MutationObserver` coordinator, `isConnected`, `getRootNode()`, `contains()`, `WeakRef`, `FinalizationRegistry` | A scope-exact fast path that skips the per-node marker walk |
| Scheduling | `queueMicrotask` through the existing `ReactiveScheduler` | None |

The platform has no keyed reconciliation and no reactive binding of template parts; DOM Parts and
Template Instantiation have not shipped. These helpers are the smallest layer that binds cloned DOM
to declared state while keeping the controller contract. If `ChildNodePart`/`AttributePart` ship, the
compile-time site walks map onto them.

The coordinator fast path keeps today's light-DOM scope exactly and retains no root the document no
longer holds: registered roots' lifecycle records are held through `WeakRef`s, pruned by a
`FinalizationRegistry`. Indexing the record rather than the element keeps a live root indexed when
a root `$match` switches it to another element, since the live runtime moves the record. The
marker walk only acts on a root whose connection no longer matches its record and that the batch's
added or removed nodes reach (`contains` and `querySelectorAll` share light-DOM scope). With at most
32 registered roots the coordinator finds those roots directly: one is synchronized, and two or more
fall back to the walk, which keeps mutation-order sequencing. Above 32 roots the walk runs.

Only direct-extend output imports the indexed coordinator (`src/generated-lifecycle-index.ts`), so
other generated output bundles exactly the coordinator it did before. Both occupy the one
coordinator slot a document has: whichever installs first serves every root registered in that
document, so two coordinators never disagree. When another coordinator installed first, direct-extend
roots get the exact walk without the fast path.

## Review sequence

The next decisions are intentionally separated so approval of one custom layer cannot be read as
approval of all runtime machinery:

1. Native build host: preserve the uniform controller contract while deriving one shared host
   implementation from the capabilities used across the application or library graph.
2. Declared reads: distinguish request behavior supplied directly by Fetch/URL/AbortController from
   proposal state and scheduling that generated output must retain.
3. Styling: resolved. The live runtime requires native `@scope`; Chromium, Firefox, and WebKit
   conformance passes. Generated targets retain the pre-`@scope` attribute mapping. See the
   Component styling row.
4. Live expressions and dependency tracking: quantify the irreducible live-authoring layer after
   generated paths have removed it from production components.
5. Resource graphs: review the security/trust behavior separately from URL and import-map parsing.
